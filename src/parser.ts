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
 */
export class INIManager {
    // 存储所有已加载的INI文件信息，键为文件路径。
    public files: Map<string, { content: string; parsed: INIFile }> = new Map();
    // Schema管理器的实例，用于获取注册表列表等规则信息。
    private schemaManager?: SchemaManager;
    // 核心索引：一个从 节ID -> 注册表名 的快速查找映射。
    private sectionToRegistryMap: Map<string, string> = new Map();
    // 反向索引: 一个从 值 -> 引用位置列表 的快速查找映射。
    private valueReferences: Map<string, vscode.Location[]> = new Map();
    // 用于调试的详细注册表信息。
    private detailedRegistryInfo: Map<string, RegistryInfo> = new Map();

    /**
     * 清空所有缓存和索引，重置管理器状态。
     */
    clear() {
        this.files.clear();
        this.sectionToRegistryMap.clear();
        this.detailedRegistryInfo.clear();
        this.valueReferences.clear();
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
                // 我们仍然解析文件以支持大纲视图等功能，但不会用这个解析结果来构建注册表索引。
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

        // 第二遍：使用原始内容构建索引。
        this.buildRegistryIndex();
        this.buildValueReferencesIndex();
    }

    /**
     * 构建一个从 节ID -> 注册表名 的索引 (例如 "GAWEAP" -> "BuildingTypes")。
     * 此方法通过逐行手动解析文件以获得最大的兼容性和准确性。
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
                    // 忽略注册表内部的空行和整行注释
                    if (trimmedLine === '' || trimmedLine.startsWith(';')) {
                        continue;
                    }
    
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
     * 构建一个从 值 -> 引用位置列表 的反向索引。
     */
    private buildValueReferencesIndex() {
        const keyValueRegex = /^\s*[^;=\s][^=]*=\s*(.*)/;

        for (const [filePath, fileData] of this.files.entries()) {
            const lines = fileData.content.split(/\r?\n/);
            const fileUri = vscode.Uri.file(filePath);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const match = line.match(keyValueRegex);
                if (match) {
                    const valuePart = match[1].split(';')[0].trim();
                    const values = valuePart.split(',');

                    for (const value of values) {
                        const trimmedValue = value.trim();
                        if (trimmedValue) {
                            const locations = this.valueReferences.get(trimmedValue) || [];
                            
                            // 计算精确的范围
                            const valueStartIndex = line.indexOf(trimmedValue);
                            if (valueStartIndex > -1) {
                                const range = new vscode.Range(i, valueStartIndex, i, valueStartIndex + trimmedValue.length);
                                locations.push(new vscode.Location(fileUri, range));
                                this.valueReferences.set(trimmedValue, locations);
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * 在所有文件中查找一个节的定义。
     * @param name 节名
     * @returns 包含文件路径和内容的对象，如果未找到则返回 null
     */
    findSection(name: string): { file: string; content: string } | null {
        for (const [filePath, { content, parsed }] of this.files.entries()) {
            if (parsed && parsed[name]) {
                return { file: filePath, content };
            }
        }
        return null;
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
                        continue; // 优化: 一旦离开目标节, 可跳过当前文件的剩余部分, 但为简单起见, 这里只跳过当前行
                    }

                    if (trimmedLine === '' || trimmedLine.startsWith(';')) {
                        continue;
                    }

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