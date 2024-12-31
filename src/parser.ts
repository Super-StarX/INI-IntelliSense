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

    loadFile(filePath: string) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = ini.parse(content);
        this.files.set(filePath, { content, parsed });
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
        const sectionHeader = `[${sectionName}]`;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === sectionHeader) {
                return i;
            }
        }
        return null;
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
