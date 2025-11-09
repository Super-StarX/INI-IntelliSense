import * as vscode from 'vscode';
import * as fs from 'fs';
import * as ini from 'ini';

export interface INISection {
    [key: string]: string | undefined;
}

export interface INIFile {
    [section: string]: INISection | undefined;
}

export class INIManager {
    public files: Map<string, { content: string; parsed: INIFile }> = new Map();

    clear() {
        this.files.clear();
    }

    loadFile(filePath: string, content?: string) {
        try {
            if (content === undefined) {
                if (!fs.existsSync(filePath)) {
                    throw new Error(`File not found: ${filePath}`);
                }
                content = fs.readFileSync(filePath, 'utf-8');
            }
            const parsed = ini.parse(content);
            this.files.set(filePath, { content, parsed });
        } catch (error) {
            console.error(`Error parsing INI file ${filePath}:`, error);
            // 即使解析失败,也存入原始内容,以便进行文本搜索
            if (content !== undefined) {
                this.files.set(filePath, { content, parsed: {} });
            }
        }
    }

    parseDocument(content: string): INIFile {
        return ini.parse(content) as INIFile;
    }

    findSection(name: string): { file: string; content: string } | null {
        for (const [filePath, { content, parsed }] of this.files.entries()) {
            if (parsed && parsed[name]) {
                return { file: filePath, content };
            }
        }
        return null;
    }

    findSectionInContent(content: string, sectionName: string): number | null {
        const lines = content.split('\n');
        // 转义节名中的正则表达式特殊字符,使其可以安全地用于匹配
        const escapedSectionName = sectionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        // 构建一个更健壮的正则表达式,以匹配如 [section], [section]:[base], [section] ; comment 等情况
        const sectionRegex = new RegExp(`^\\[${escapedSectionName}\\](?::\\[.*\\])?(?:\\s*;.*)?$`, 'i');

        for (let i = 0; i < lines.length; i++) {
            if (sectionRegex.test(lines[i].trim())) {
                return i;
            }
        }
        return null;
    }

    /**
     * 在已索引的所有文件中查找一个节(section)属于哪个注册表(registry)
     * @param sectionName 要查找的节名, 如 "GAWEAP"
     * @returns 注册表名, 如 "BuildingTypes", 未找到则返回 null
     */
    public findRegistryForSection(sectionName: string): string | null {
        for (const fileData of this.files.values()) {
            if (!fileData.parsed) continue;
    
            for (const [registryName, sectionContent] of Object.entries(fileData.parsed)) {
                // 注册表通常是一个节, 其值是ID列表
                // 这里做一个更健壮的检查, 确保 sectionContent 是对象且非空
                if (typeof sectionContent === 'object' && sectionContent !== null && Object.keys(sectionContent).length > 0) {
                    // [BuildingTypes] 下面的键是序号 0, 1, 2... 值是 ID
                    if (Object.values(sectionContent).includes(sectionName)) {
                        return registryName;
                    }
                }
            }
        }
        return null;
    }

    /**
     * 遍历所有已索引文件, 获取所有唯一的节名
     * @returns 一个包含所有节名的 Set
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
     * 遍历所有已索引文件, 获取所有唯一的非对象值
     * @returns 一个包含所有值的 Set
     */
    public getAllValues(): Set<string> {
        const values = new Set<string>();
        for (const fileData of this.files.values()) {
            if (fileData.parsed) {
                for (const section of Object.values(fileData.parsed)) {
                    if (typeof section === 'object' && section !== null) {
                        for (const value of Object.values(section)) {
                            // 只添加基础类型的值, 并处理逗号分隔的列表
                            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                                String(value).split(',').forEach(part => {
                                    const trimmedPart = part.trim();
                                    if (trimmedPart) values.add(trimmedPart);
                                });
                            }
                        }
                    }
                }
            }
        }
        return values;
    }

    getSectionComment(content: string, sectionName: string) {
        const lines = content.split('\n');
        let sectionIndex = -1;
        let comments = [];
        let inlineComment = null;
    
        // 找到 section 的定义行
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
    
            // 检查右侧注释
            if (line.startsWith(`[${sectionName}]`)) {
                sectionIndex = i;
    
                // 检查是否有右侧注释
                const inlineIndex = line.indexOf(';');
                if (inlineIndex !== -1) {
                    inlineComment = line.substring(inlineIndex + 1).trim();
                }
                break;
            }
        }
    
        if (sectionIndex === -1) {return null;} // 未找到 section
    
        // 向上查找多行注释
        for (let i = sectionIndex - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith(';')) {
                comments.unshift(line.substring(1).trim() + '\n');
            } else if (line.length > 0) {
                break; // 遇到非注释或空行，停止向上查找
            }
        }
    
        // 优先返回上方注释（如果有），其次是右侧注释
        if (comments.length > 0) {
            return comments.join('\n');
        } else if (inlineComment) {
            return inlineComment;
        }
    
        return null; // 没有找到任何注释
    }
}