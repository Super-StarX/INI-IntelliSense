import * as vscode from 'vscode';
import * as fs from 'fs';
import * as ini from 'ini';
import { SchemaManager } from './schema-manager';

/**
 * 定义一个INI文件解析后的结构。
 * 键是节名，值是该节下所有键值对的对象。
 */
export interface INIFile {
    [section: string]: any;
}

/**
 * 用于调试日志，存储一个注册表的详细信息。
 */
interface RegistryInfo {
    // 记录该注册表在哪些文件的哪一行出现过。
    occurrences: { filePath: string; lineNumber: number }[];
    // 存储该注册表下所有唯一的ID。
    ids: Set<string>;
}

/**
 * INI文件管理器
 * 负责加载、解析和索引工作区内的所有INI文件。
 * 它构建交叉引用信息，并提供高级类型推断能力。
 */
export class INIManager {
    // 存储所有已加载的INI文件信息，键为文件路径。
    public files: Map<string, { content: string; parsed: INIFile }> = new Map();
    // Schema管理器的实例，用于获取注册表列表等规则信息。
    private schemaManager?: SchemaManager;
    // 核心索引：一个从 节ID -> 注册表名 的快速查找映射。
    private sectionToRegistryMap: Map<string, string> = new Map();
    // 存储节的继承关系: 子节 -> 父节
    private sectionInheritance: Map<string, string> = new Map();
    // 反向索引：从 值 -> 引用位置列表 的快速查找映射 (用于 Key=Value)。
    public valueReferences: Map<string, vscode.Location[]> = new Map();
    // 反向索引：从 父节 -> 继承位置列表 的快速查找映射 (用于 [Child]:[Parent])。
    public inheritanceReferences: Map<string, vscode.Location[]> = new Map();
    // 用于调试的详细注册表信息。
    private detailedRegistryInfo: Map<string, RegistryInfo> = new Map();
    // 缓存通过引用推断出的类型，避免重复计算，提升性能。
    private inferredTypeCache = new Map<string, string>();

    /**
     * 清空所有缓存和索引，重置管理器状态。
     */
    clear() {
        this.files.clear();
        this.sectionToRegistryMap.clear();
        this.detailedRegistryInfo.clear();
        this.valueReferences.clear();
        this.inheritanceReferences.clear();
        this.sectionInheritance.clear();
        this.inferredTypeCache.clear();
    }
    
    /**
     * 注入 SchemaManager 的实例。
     * @param manager SchemaManager的实例
     */
    setSchemaManager(manager: SchemaManager) {
        this.schemaManager = manager;
    }

    /**
     * 索引指定的所有INI文件。
     * @param fileUris 文件URI的数组
     */
    async indexFiles(fileUris: vscode.Uri[]) {
        this.clear();

        // 第一遍：加载所有文件到内存中。
        for (const fileUri of fileUris) {
            try {
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                const content = Buffer.from(fileContentBytes).toString('utf8');
                // 仍然解析文件以支持大纲视图等功能，但索引将基于更可靠的文本分析。
                const parsed = ini.parse(content); 
                this.files.set(fileUri.fsPath, { content, parsed });
            } catch (error) {
                // 如果解析失败，存储原始内容以支持基于文本的功能。
                if (error instanceof Error && 'content' in error) {
                    this.files.set(fileUri.fsPath, { content: (error as any).content, parsed: {} });
                }
                console.error(`解析INI文件失败 ${fileUri.fsPath}:`, error);
            }
        }

        // 第二遍：使用原始内容构建所有索引。
        this.buildRegistryIndex();
        this.buildCrossReferencesIndex();
    }

    /**
     * 构建一个从 节ID -> 注册表名 的索引 (例如 "GAWEAP" -> "BuildingTypes")。
     */
    private buildRegistryIndex() {
        if (!this.schemaManager) return;
    
        const idListRegistryNames = this.schemaManager.getIdListRegistryNames();
        if (idListRegistryNames.size === 0) return;
    
        for (const [filePath, fileData] of this.files.entries()) {
            const lines = fileData.content.split(/\r?\n/);
            let currentRegistryName: string | null = null;
    
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmedLine = line.trim();
    
                // 规则 1：总是最先检查是否为节头。
                if (trimmedLine.startsWith('[')) {
                    const closingBracketIndex = trimmedLine.indexOf(']');
                    // 确保找到了一个有效的闭合括号
                    if (closingBracketIndex > 0) {
                        // 提取括号内的完整内容
                        const contentInsideBrackets = trimmedLine.substring(1, closingBracketIndex);
                        // 通过':'分割来处理继承，并取第一部分作为节名
                        const sectionName = contentInsideBrackets.split(':')[0].trim();

                        // 如果这个节是一个已知的ID列表注册表，则更新我们的状态。
                        if (idListRegistryNames.has(sectionName)) {
                            currentRegistryName = sectionName;

                            // 为调试日志记录此注册表出现的位置
                            if (!this.detailedRegistryInfo.has(sectionName)) {
                                this.detailedRegistryInfo.set(sectionName, { occurrences: [], ids: new Set() });
                            }
                            this.detailedRegistryInfo.get(sectionName)!.occurrences.push({ filePath, lineNumber: i });
                        } else {
                            // 如果是任何其他节，我们就不再处于一个注册表内部。
                            // 这是防止状态污染的关键修复。
                            currentRegistryName = null;
                        }
                        // 该行是节头，已处理完毕，继续到下一行。
                        continue;
                    }
                }
    
                // 规则 2：只有当我们确认处于一个注册表节的内部时，才处理这一行。
                if (currentRegistryName) {
                    if (trimmedLine === '' || trimmedLine.startsWith(';')) continue;
    
                    // 提取ID值
                    let value = trimmedLine.split(';')[0].trim();
                    if (!value) continue;

                    const equalsIndex = value.indexOf('=');
                    if (equalsIndex !== -1) {
                        value = value.substring(equalsIndex + 1).trim();
                    }
                    
                    if (value) {
                        this.sectionToRegistryMap.set(value, currentRegistryName);
                        // 同时添加到详细信息中用于计数
                        this.detailedRegistryInfo.get(currentRegistryName)!.ids.add(value);
                    }
                }
            }
        }
    }

    /**
     * 构建交叉引用索引，此方法会同时扫描值引用（Key=Value）和继承引用（[Child]:[Parent]）。
     */
    private buildCrossReferencesIndex() {
        const keyValueRegex = /^\s*[^;=\s][^=]*=\s*(.*)/;
        const inheritanceRegex = /^\s*\[([^\]:]+)\]\s*:\s*\[([^\]]+)\]/;

        for (const [filePath, fileData] of this.files.entries()) {
            const lines = fileData.content.split(/\r?\n/);
            const fileUri = vscode.Uri.file(filePath);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // 检查继承引用
                const inheritanceMatch = line.match(inheritanceRegex);
                if (inheritanceMatch) {
                    const childName = inheritanceMatch[1].trim();
                    const parentName = inheritanceMatch[2].trim();
                    if (childName && parentName) {
                        this.sectionInheritance.set(childName, parentName);
                        const locations = this.inheritanceReferences.get(parentName) || [];
                        const parentStartIndex = line.lastIndexOf(parentName);
                        if (parentStartIndex > -1) {
                            const range = new vscode.Range(i, parentStartIndex, i, parentStartIndex + parentName.length);
                            locations.push(new vscode.Location(fileUri, range));
                            this.inheritanceReferences.set(parentName, locations);
                        }
                    }
                }

                // 检查键值引用
                const kvMatch = line.match(keyValueRegex);
                if (kvMatch) {
                    const valuePart = kvMatch[1].split(';')[0];
                    const values = valuePart.split(',');
                    let searchOffset = line.indexOf('=') + 1;

                    for (const value of values) {
                        const trimmedValue = value.trim();
                        if (trimmedValue) {
                            // 为了精确匹配，在行的值部分查找
                            const valueStartIndex = line.indexOf(trimmedValue, searchOffset);
                            if (valueStartIndex > -1) {
                                const range = new vscode.Range(i, valueStartIndex, i, valueStartIndex + trimmedValue.length);
                                const locations = this.valueReferences.get(trimmedValue) || [];
                                locations.push(new vscode.Location(fileUri, range));
                                this.valueReferences.set(trimmedValue, locations);
                                searchOffset = valueStartIndex + trimmedValue.length;
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * 在所有文件中查找一个节的所有定义片段。
     * @param name 节名
     * @returns 包含所有定义了该节的文件信息的数组
     */
    findSection(name: string): { file: string; content: string }[] {
        const results: { file: string; content: string }[] = [];
        const escapedSectionName = name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const sectionRegex = new RegExp(`^\\[${escapedSectionName}\\]`, 'im');
    
        for (const [filePath, { content }] of this.files.entries()) {
            if (sectionRegex.test(content)) {
                results.push({ file: filePath, content });
            }
        }
        return results;
    }

    /**
     * 在给定的文本内容中查找节定义的行号。
     * @param content 文件内容
     * @param sectionName 节名
     * @returns 行号（从0开始），如果未找到则返回 null
     */
    findSectionInContent(content: string, sectionName: string): number | null {
        const lines = content.split('\n');
        const escapedSectionName = sectionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const sectionRegex = new RegExp(`^\\[${escapedSectionName}\\](?::\\[.*\\])?(?:\\s*;.*)?$`, 'i');

        for (let i = 0; i < lines.length; i++) {
            if (sectionRegex.test(lines[i].trim())) {
                return i;
            }
        }
        return null;
    }
    
    /**
     * 在整个工作区中查找特定节内某个键的首次出现位置和行文本。
     * @param sectionName 要搜索的节名
     * @param keyName 要查找的键名
     * @returns 包含位置和行文本的对象，如果未找到则返回 null
     */
    public findKeyLocation(sectionName: string, keyName: string): { location: vscode.Location; lineText: string } | null {
        const sectionInfos = this.findSection(sectionName);
        if (sectionInfos.length === 0) {
            return null;
        }

        for (const sectionInfo of sectionInfos) {
            const lines = sectionInfo.content.split(/\r?\n/);
            let inSection = false;
            
            const escapeRegex = (str: string) => str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const sectionRegex = new RegExp(`^\\[${escapeRegex(sectionName)}\\]`);
            const keyRegex = new RegExp(`^\\s*${escapeRegex(keyName)}\\s*=`);
            const nextSectionRegex = /^\s*\[.+\]/;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmedLine = line.trim();
                if (sectionRegex.test(trimmedLine)) {
                    inSection = true;
                    continue;
                }
                
                if (inSection) {
                    if (keyRegex.test(line)) {
                        const keyStartIndex = line.indexOf(keyName);
                        const range = new vscode.Range(i, keyStartIndex, i, keyStartIndex + keyName.length);
                        const location = new vscode.Location(vscode.Uri.file(sectionInfo.file), range);
                        return { location, lineText: line.trim() };
                    }
                    if (nextSectionRegex.test(trimmedLine)) {
                        // 在同一个文件内，如果遇到了下一个节，就停止对这个文件的搜索
                        inSection = false; 
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * 递归地向上查找一个键在实例继承链中的首次定义位置。
     * @param sectionName 起始节名
     * @param keyName 要查找的键名
     * @returns 包含最终位置、行文本和定义节名的对象
     */
    public findKeyLocationRecursive(
        sectionName: string, 
        keyName: string
    ): { location: vscode.Location | null; lineText: string | null, definer: string | null } {
        
        let currentSection: string | null = sectionName;
        const visited = new Set<string>();

        while (currentSection && !visited.has(currentSection)) {
            visited.add(currentSection);

            const result = this.findKeyLocation(currentSection, keyName);
            if (result) {
                return { ...result, definer: currentSection };
            }

            currentSection = this.getInheritance(currentSection) ?? null;
        }

        return { location: null, lineText: null, definer: null };
    }

    /**
     * 根据节名推断其类型，采用多级回退策略（直接匹配 -> 注册表 -> 引用推断）。
     * @param sectionName 要推断的节名
     * @param visited 用于防止在递归推断中出现无限循环
     * @returns 推断出的类型名，如果无法推断则返回节名本身
     */
    public getTypeForSection(sectionName: string, visited: Set<string> = new Set()): string {
        if (!this.schemaManager) return sectionName;

        // --- 0. 递归保护 ---
        if (visited.has(sectionName)) {
            return sectionName; // 检测到循环引用，返回自身以中断
        }
        visited.add(sectionName);

        // --- 1. 检查缓存 ---
        if (this.inferredTypeCache.has(sectionName)) {
            return this.inferredTypeCache.get(sectionName)!;
        }

        // --- 2. 直接类型匹配 ---
        if (this.schemaManager.isSchemaType(sectionName)) {
            this.inferredTypeCache.set(sectionName, sectionName);
            return sectionName;
        }

        // --- 3. 注册表查找 ---
        const registryName = this.findRegistryForSection(sectionName);
        if (registryName) {
            const typeName = this.schemaManager.getTypeForRegistry(registryName) ?? sectionName;
            this.inferredTypeCache.set(sectionName, typeName);
            return typeName;
        }

        // --- 4. 通过引用反向推断 ---
        const references = this.valueReferences.get(sectionName);
        if (references) {
            for (const location of references) {
                const lineText = this.files.get(location.uri.fsPath)?.content.split(/\r?\n/)[location.range.start.line];
                if (!lineText) continue;

                const kvMatch = lineText.match(/^\s*([^;=\s][^=]*?)\s*=/);
                if (!kvMatch) continue;

                const key = kvMatch[1].trim();
                const contextSectionName = this.getSectionNameAtLine(location.uri.fsPath, location.range.start.line);
                if (!contextSectionName) continue;

                // 递归调用以确定引用上下文的类型
                const contextTypeName = this.getTypeForSection(contextSectionName, visited);
                const allKeys = this.schemaManager.getAllKeysForType(contextTypeName);
                
                let valueType: string | undefined;
                for (const [k, v] of allKeys.entries()) {
                    if (k.toLowerCase() === key.toLowerCase()) {
                        valueType = v;
                        break;
                    }
                }
                
                // 如果找到的期望类型是一个复杂的对象类型（定义在[Sections]中），则推断成功
                if (valueType && this.schemaManager.isComplexType(valueType)) {
                    this.inferredTypeCache.set(sectionName, valueType);
                    return valueType;
                }
            }
        }

        // --- 5. 回退 ---
        this.inferredTypeCache.set(sectionName, sectionName);
        return sectionName;
    }

    /**
     * 获取指定节的父节名称。
     * @param sectionName 子节的名称
     * @returns 父节的名称，如果没有则返回 undefined
     */
    public getInheritance(sectionName: string): string | undefined {
        return this.sectionInheritance.get(sectionName);
    }
    
    /**
     * 获取指定位置所在的节的名称。
     * @param filePath 文件路径
     * @param lineNumber 行号
     * @returns 节名，如果未找到则返回 null
     */
    private getSectionNameAtLine(filePath: string, lineNumber: number): string | null {
        const fileData = this.files.get(filePath);
        if (!fileData) return null;
        
        const lines = fileData.content.split(/\r?\n/);
        for (let i = lineNumber; i >= 0; i--) {
            const match = lines[i].match(/^\s*\[([^\]:]+)/);
            if (match) {
                return match[1].trim();
            }
        }
        return null;
    }


    /**
     * 高效地从索引中查找一个节属于哪个注册表。
     * @param sectionName 要查找的节名, 如 "GAWEAP"
     * @returns 注册表名, 如 "BuildingTypes", 未找到则返回 undefined
     */
    public findRegistryForSection(sectionName: string): string | undefined {
        return this.sectionToRegistryMap.get(sectionName);
    }

    /**
     * 高效地从反向索引中查找一个名称的所有引用位置。
     * @param name 要查找的名称 (通常是一个节 ID)
     * @returns 包含所有引用位置的 Location 数组
     */
    public findReferences(name: string): vscode.Location[] {
        return this.valueReferences.get(name) || [];
    }

    /**
     * 获取已索引的注册表ID总数。
     */
    public getRegistryMapSize(): number {
        return this.sectionToRegistryMap.size;
    }

    /**
     * 获取完整的注册表索引 Map, 仅用于调试。
     */
    public getRegistryMap(): Map<string, string> {
        return this.sectionToRegistryMap;
    }
    
    /**
     * 获取详细的注册表信息, 仅用于调试。
     */
    public getDetailedRegistryInfo(): Map<string, RegistryInfo> {
        return this.detailedRegistryInfo;
    }

    /**
     * 遍历所有已索引文件, 获取所有唯一的节名。
     * @returns 包含所有节名的 Set
     */
    public getAllSectionNames(): Set<string> {
        const sectionNames = new Set<string>();
        for (const fileData of this.files.values()) {
            if (fileData.parsed) {
                Object.keys(fileData.parsed).forEach(name => sectionNames.add(name));
            }
        }
        return sectionNames;
    }
    
    /**
     * 在所有文件中搜索特定键的所有值。
     * @param keyName 要搜索的键名
     * @returns 包含所有不重复值的 Set
     */
    public getValuesForKey(keyName: string): Set<string> {
        const values = new Set<string>();
        if (!keyName) {
            return values;
        }

        const escapeRegex = (str: string) => str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const keyRegex = new RegExp(`^\\s*${escapeRegex(keyName)}\\s*=(.*)`);

        for (const fileData of this.files.values()) {
            const lines = fileData.content.split(/\r?\n/);
            for (const line of lines) {
                const match = line.match(keyRegex);
                if (match && match[1]) {
                    const valuePart = match[1].split(';')[0].trim();
                    valuePart.split(',').forEach(part => {
                        const trimmedPart = part.trim();
                        if (trimmedPart) {
                            values.add(trimmedPart);
                        }
                    });
                }
            }
        }
        return values;
    }

    /**
     * 从所有文件中提取指定注册表下的所有ID。
     * @param registryName 要查询的注册表名称, 如 "Animations"
     * @returns 包含该注册表下所有ID的 Set
     */
    public getValuesForRegistry(registryName: string): Set<string> {
        const values = new Set<string>();
        if (!registryName) return values;

        const escapedRegistryName = registryName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const sectionRegex = new RegExp(`^\\[${escapedRegistryName}\\]`, 'i');
        const nextSectionRegex = /^\s*\[.+\]/;

        for (const fileData of this.files.values()) {
            const lines = fileData.content.split(/\r?\n/);
            let inTargetRegistry = false;

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (sectionRegex.test(trimmedLine)) {
                    inTargetRegistry = true;
                    continue;
                }

                if (inTargetRegistry) {
                    if (nextSectionRegex.test(trimmedLine)) {
                        inTargetRegistry = false;
                        continue;
                    }

                    if (trimmedLine === '' || trimmedLine.startsWith(';')) continue;

                    let value = trimmedLine.split(';')[0].trim();
                    if (value) {
                        const equalsIndex = value.indexOf('=');
                        if (equalsIndex !== -1) {
                            value = value.substring(equalsIndex + 1).trim();
                        }
                        if (value) values.add(value);
                    }
                }
            }
        }
        return values;
    }

    /**
     * 获取一个节的注释（包括节上方或行内的注释）。
     * @param content 文件内容
     * @param sectionName 节名
     */
    getSectionComment(content: string, sectionName: string) {
        const lines = content.split('\n');
        let sectionIndex = -1;
        let comments = [];
        let inlineComment = null;
    
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
    
            if (line.startsWith(`[${sectionName}]`)) {
                sectionIndex = i;
    
                const inlineIndex = line.indexOf(';');
                if (inlineIndex !== -1) {
                    inlineComment = line.substring(inlineIndex + 1).trim();
                }
                break;
            }
        }
    
        if (sectionIndex === -1) {return null;}
    
        for (let i = sectionIndex - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith(';')) {
                comments.unshift(line.substring(1).trim() + '\n');
            } else if (line.length > 0) {
                break;
            }
        }
    
        if (comments.length > 0) {
            return comments.join('\n');
        } else if (inlineComment) {
            return inlineComment;
        }
    
        return null;
    }
}