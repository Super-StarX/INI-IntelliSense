import * as vscode from 'vscode';
import * as ini from 'ini';
import { SchemaManager } from './schema-manager';
import { FileTypeManager } from './file-type-manager';

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
    // 文件类型管理器的实例
    private fileTypeManager?: FileTypeManager;
    
    // 核心索引：一个从 节ID -> 注册表名 的快速查找映射。
    private sectionToRegistryMap: Map<string, string> = new Map();
    // 存储节的继承关系: 子节 -> 父节
    private sectionInheritance: Map<string, Map<string, string>> = new Map();
    // 反向索引：从 值 -> 引用位置列表 的快速查找映射 (用于 Key=Value)。
    public valueReferences: Map<string, vscode.Location[]> = new Map();
    // 反向索引：从 父节 -> 继承位置列表 的快速查找映射 (用于 [Child]:[Parent])。
    public inheritanceReferences: Map<string, vscode.Location[]> = new Map();
    // 存储节定义的位置，用于“跳转到定义”
    private sectionLocations: Map<string, vscode.Location[]> = new Map();
    // 用于调试的详细注册表信息。
    private detailedRegistryInfo: Map<string, RegistryInfo> = new Map();
    // 缓存通过引用推断出的类型，避免重复计算，提升性能。
    private inferredTypeCache = new Map<string, string>();

    /**
     * 清空所有缓存和索引，重置管理器状态。
     */
    private clearAllIndexes() {
        this.sectionToRegistryMap.clear();
        this.detailedRegistryInfo.clear();
        this.valueReferences.clear();
        this.inheritanceReferences.clear();
        this.sectionInheritance.clear();
        this.sectionLocations.clear();
        this.inferredTypeCache.clear();
    }

    setSchemaManager(manager: SchemaManager) {
        this.schemaManager = manager;
    }

    setFileTypeManager(manager: FileTypeManager) {
        this.fileTypeManager = manager;
    }

    /**
     * 全量索引指定的所有INI文件。仅在初始化时调用。
     * @param fileUris 文件URI的数组
     */
    async indexFiles(fileUris: vscode.Uri[]) {
        this.files.clear();
        this.clearAllIndexes();

        for (const fileUri of fileUris) {
            try {
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                const content = Buffer.from(fileContentBytes).toString('utf8');
                this.files.set(fileUri.fsPath, { content, parsed: ini.parse(content) });
            } catch (error) {
                console.error(`Failed to parse INI file ${fileUri.fsPath}:`, error);
            }
        }
        
        // 全量构建所有索引
        this.rebuildAllIndexes();
    }

    /**
     * 增量更新单个文件的索引。
     * @param uri 变更文件的URI
     * @param content 可选，文件的最新内容。如果未提供，将从磁盘读取。
     */
    async updateFile(uri: vscode.Uri, content?: string) {
        try {
            const fileContent = content ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            this.files.set(uri.fsPath, { content: fileContent, parsed: ini.parse(fileContent) });
            
            // 简单起见，我们选择在任何文件变更时重建所有索引
            // 这是一个折衷方案，比每次都重新读取所有文件要快得多
            this.rebuildAllIndexes();
        } catch (error) {
            console.error(`Failed to update index for file ${uri.fsPath}:`, error);
        }
    }

    /**
     * 从索引中移除一个文件。
     * @param uri 被删除文件的URI
     */
    removeFile(uri: vscode.Uri) {
        if (this.files.has(uri.fsPath)) {
            this.files.delete(uri.fsPath);
            this.rebuildAllIndexes();
        }
    }

    /**
     * 基于当前 `this.files` 中的内容，重新构建所有索引。
     */
    private rebuildAllIndexes() {
        this.clearAllIndexes();
        // 依次构建各个索引
        this.buildRegistryIndex();
        this.buildCrossReferencesIndex();
    }

    /**
     * 构建一个从 节ID -> 注册表名 的索引 (例如 "GAWEAP" -> "BuildingTypes")。
     */
    private buildRegistryIndex() {
        if (!this.schemaManager) {return;}
    
        const idListRegistryNames = this.schemaManager.getIdListRegistryNames();
        if (idListRegistryNames.size === 0) {return;}
    
        for (const [filePath, fileData] of this.files.entries()) {
            const lines = fileData.content.split(/\r?\n/);
            let currentRegistryName: string | null = null;
    
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmedLine = line.trim();
    
                if (trimmedLine.startsWith('[')) {
                    const closingBracketIndex = trimmedLine.indexOf(']');
                    if (closingBracketIndex > 0) {
                        const contentInsideBrackets = trimmedLine.substring(1, closingBracketIndex);
                        const sectionName = contentInsideBrackets.split(':')[0].trim();

                        if (idListRegistryNames.has(sectionName)) {
                            currentRegistryName = sectionName;
                            if (!this.detailedRegistryInfo.has(sectionName)) {
                                this.detailedRegistryInfo.set(sectionName, { occurrences: [], ids: new Set() });
                            }
                            this.detailedRegistryInfo.get(sectionName)!.occurrences.push({ filePath, lineNumber: i });
                        } else {
                            currentRegistryName = null;
                        }
                        continue;
                    }
                }
    
                if (currentRegistryName) {
                    if (trimmedLine === '' || trimmedLine.startsWith(';')) {continue;}
    
                    let value = trimmedLine.split(';')[0].trim();
                    if (!value) {continue;}

                    const equalsIndex = value.indexOf('=');
                    if (equalsIndex !== -1) {
                         // This handles lines like `0=ID` in registry lists
                        const keyPart = value.substring(0, equalsIndex).trim();
                        if (/^\d+$/.test(keyPart)) {
                             value = value.substring(equalsIndex + 1).trim();
                        }
                    }
                    
                    if (value) {
                        this.sectionToRegistryMap.set(value, currentRegistryName);
                        this.detailedRegistryInfo.get(currentRegistryName)!.ids.add(value);
                    }
                }
            }
        }
    }

    /**
     * 构建交叉引用索引，包括值引用、继承引用和节定义位置。
     */
    private buildCrossReferencesIndex() {
        const sectionRegex = /^\s*\[([^\]:]+)\](?::\[([^\]]+)\])?(?:[ \t]*;.*)?$/;
        const keyValueRegex = /^\s*[^;=\s][^=]*=\s*(.*)/;

        for (const [filePath, fileData] of this.files.entries()) {
            const lines = fileData.content.split(/\r?\n/);
            const fileUri = vscode.Uri.file(filePath);
            const currentFileType = this.fileTypeManager?.getFileType(fileUri) || 'INI';

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // 检查节定义和继承引用
                const sectionMatch = line.match(sectionRegex);
                if (sectionMatch) {
                    const sectionName = sectionMatch[1].trim();
                    const parentName = sectionMatch[2] ? sectionMatch[2].trim() : null;
                    
                    if (sectionName) {
                        const locations = this.sectionLocations.get(sectionName) || [];
                        locations.push(new vscode.Location(fileUri, new vscode.Position(i, line.indexOf(sectionName))));
                        this.sectionLocations.set(sectionName, locations);
                    }

                    if (parentName) {
                        if (!this.sectionInheritance.has(currentFileType)) {
                            this.sectionInheritance.set(currentFileType, new Map());
                        }
                        this.sectionInheritance.get(currentFileType)!.set(sectionName, parentName);

                        // inheritanceReferences 用于"查找所有引用"，这个依然可以是全局的，或者你也想隔离引用查找？
                        // 通常引用查找是希望全局的，但继承逻辑必须隔离。这里我们只改了 inheritance 存储。
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
     * @param filterFileType (可选) 过滤特定的文件类型。如果为 'INI' 或未定义，则搜索所有文件。
     *                       如果为特定类型（如 'rules'），则只返回属于该类型文件的定义。
     * @returns 包含所有定义了该节的文件信息的数组
     */
    findSection(name: string, filterFileType?: string): { file: string; content: string }[] {
        const results: { file: string; content: string }[] = [];
        const locations = this.sectionLocations.get(name) || [];

        for (const location of locations) {
            const filePath = location.uri.fsPath;
            
            // 文件类型隔离逻辑：
            // 如果指定了过滤类型，且该类型不是通用的 'INI'，则只允许匹配同类型的文件。
            if (filterFileType && filterFileType !== 'INI' && this.fileTypeManager) {
                const currentFileCategory = this.fileTypeManager.getFileType(location.uri);
                if (currentFileCategory !== filterFileType) {
                    continue;
                }
            }

            const fileData = this.files.get(filePath);
            if (fileData) {
                results.push({ file: filePath, content: fileData.content });
            }
        }
        return results;
    }

    /**
     * 在索引中查找节的所有定义位置。
     * @param name 节名
     * @returns vscode.Location 数组
     */
    findSectionLocations(name: string): vscode.Location[] {
        return this.sectionLocations.get(name) || [];
    }
    
    /**
     * 在给定的文本内容中查找节定义的范围。
     * @param content 文件内容
     * @param sectionName 节名
     * @returns 节的起始和结束位置，如果未找到则返回 null
     */
    findSectionRange(content: string, sectionName: string): vscode.Range | null {
        const lines = content.split(/\r?\n/);
        const escapedSectionName = sectionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const sectionRegex = new RegExp(`^\\[${escapedSectionName}\\]`, 'i');
        const nextSectionRegex = /^\s*\[.+\]/;

        let startLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (sectionRegex.test(lines[i].trim())) {
                startLine = i;
                break;
            }
        }
        
        if (startLine === -1) {
            return null;
        }
        
        let endLine = lines.length;
        for (let i = startLine + 1; i < lines.length; i++) {
            if (nextSectionRegex.test(lines[i].trim())) {
                endLine = i;
                break;
            }
        }
        
        // 结束位置应为下一节的开始，或文件的末尾
        const startPos = new vscode.Position(startLine, 0);
        const endPos = new vscode.Position(endLine -1, lines[endLine - 1].length);
        
        return new vscode.Range(startPos, endPos);
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
     * @param contextFileType (可选) 上下文文件类型，用于隔离搜索范围
     * @returns 包含位置和行文本的对象，如果未找到则返回 null
     */
    public findKeyLocation(sectionName: string, keyName: string, contextFileType?: string): { location: vscode.Location; lineText: string } | null {
        // 使用带有类型过滤的 findSection
        const sectionInfos = this.findSection(sectionName, contextFileType);
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
     * @param contextFileType (可选) 当前上下文的文件类型，用于继承隔离
     * @returns 包含最终位置、行文本和定义节名的对象
     */
    public findKeyLocationRecursive(
        sectionName: string, 
        keyName: string,
        contextFileType?: string
    ): { location: vscode.Location | null; lineText: string | null, definer: string | null } {
        
        let currentSection: string | null = sectionName;
        const visited = new Set<string>();

        while (currentSection && !visited.has(currentSection)) {
            visited.add(currentSection);

            // 在查找键的位置时，传入上下文文件类型
            const result = this.findKeyLocation(currentSection, keyName, contextFileType);
            if (result) {
                return { ...result, definer: currentSection };
            }

            currentSection = this.getInheritance(currentSection) ?? null;
        }

        return { location: null, lineText: null, definer: null };
    }

    /**
     * 根据节名推断其类型。
     */
    public getTypeForSection(sectionName: string, visited: Set<string> = new Set()): string {
        if (!this.schemaManager) {return sectionName;}
        if (visited.has(sectionName)) { return sectionName; }
        visited.add(sectionName);
        if (this.inferredTypeCache.has(sectionName)) { return this.inferredTypeCache.get(sectionName)!; }
        if (this.schemaManager.isSchemaType(sectionName)) {
            this.inferredTypeCache.set(sectionName, sectionName);
            return sectionName;
        }
        const registryName = this.findRegistryForSection(sectionName);
        if (registryName) {
            const typeName = this.schemaManager.getTypeForRegistry(registryName) ?? sectionName;
            this.inferredTypeCache.set(sectionName, typeName);
            return typeName;
        }
        const references = this.valueReferences.get(sectionName);
        if (references) {
            for (const location of references) {
                const lineText = this.files.get(location.uri.fsPath)?.content.split(/\r?\n/)[location.range.start.line];
                if (!lineText) {continue;}
                const kvMatch = lineText.match(/^\s*([^;=\s][^=]*?)\s*=/);
                if (!kvMatch) {continue;}
                const key = kvMatch[1].trim();
                const contextSectionName = this.getSectionNameAtLine(location.uri.fsPath, location.range.start.line);
                if (!contextSectionName) {continue;}
                const contextTypeName = this.getTypeForSection(contextSectionName, visited);
                const allKeys = this.schemaManager.getAllKeysForType(contextTypeName);
                
                let valueType: string | undefined;
                for (const [k, v] of allKeys.entries()) {
                    if (k.toLowerCase() === key.toLowerCase()) {
                        valueType = v.type; // 注意：这里v变成了对象，取type属性
                        break;
                    }
                }
                
                if (valueType && this.schemaManager.isComplexType(valueType)) {
                    this.inferredTypeCache.set(sectionName, valueType);
                    return valueType;
                }
            }
        }
        this.inferredTypeCache.set(sectionName, sectionName);
        return sectionName;
    }

    /**
     * 获取指定节的父节名称。
     * 现在需要传入 contextFileType 来确定在哪个继承上下文中查找。
     * @param sectionName 子节的名称
     * @param fileType 当前上下文的文件类型
     * @returns 父节的名称，如果没有则返回 undefined
     */
    public getInheritance(sectionName: string, fileType: string = 'INI'): string | undefined {
        const typeMap = this.sectionInheritance.get(fileType);
        return typeMap ? typeMap.get(sectionName) : undefined;
    }
    
    /**
     * 获取指定位置所在的节的名称。
     * @param filePath 文件路径
     * @param lineNumber 行号
     * @returns 节名，如果未找到则返回 null
     */
    public getSectionNameAtLine(filePath: string, lineNumber: number): string | null {
        const fileData = this.files.get(filePath);
        if (!fileData) {return null;}
        
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
     * 获取指定节的解析数据。
     * 注意：此方法返回的是简单的 key-value 对象，不包含复杂的继承或类型过滤。
     */
    public getSectionData(sectionName: string): { [key: string]: any } | undefined {
        for (const file of this.files.values()) {
            if (file.parsed[sectionName]) {
                return file.parsed[sectionName];
            }
        }
        return undefined;
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
        return new Set(this.sectionLocations.keys());
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
        if (!registryName) {return values;}

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

                    if (trimmedLine === '' || trimmedLine.startsWith(';')) {continue;}

                    let value = trimmedLine.split(';')[0].trim();
                    if (value) {
                        const equalsIndex = value.indexOf('=');
                        if (equalsIndex !== -1) {
                            value = value.substring(equalsIndex + 1).trim();
                        }
                        if (value) {values.add(value);}
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