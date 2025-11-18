import * as vscode from 'vscode';
import { INIManager } from '../parser';

/**
 * 为 INI 节提供重命名功能。
 */
export class IniRenameProvider implements vscode.RenameProvider {

    constructor(private iniManager: INIManager) {}

    prepareRename?(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string; }> {
        const range = this.getSectionNameRange(document, position);
        if (range) {
            return range;
        }
        // 如果不在一个可重命名的节名上，则抛出错误以阻止重命名操作
        throw new Error("You can only rename INI section headers (e.g., [SECTION]).");
    }
    
    async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit | null> {
        const range = this.getSectionNameRange(document, position);
        if (!range) {
            return null;
        }
        
        const oldName = document.getText(range);
        if (oldName === newName) {
            return null;
        }
        
        const workspaceEdit = new vscode.WorkspaceEdit();
        
        // 查找并替换所有定义
        const definitions = this.iniManager.findSectionLocations(oldName);
        for (const location of definitions) {
            const defRange = this.getSectionNameRange(await vscode.workspace.openTextDocument(location.uri), location.range.start);
            if (defRange) {
                workspaceEdit.replace(location.uri, defRange, newName);
            }
        }

        // 查找并替换所有作为值的引用
        const valueReferences = this.iniManager.valueReferences.get(oldName) || [];
        for (const location of valueReferences) {
            workspaceEdit.replace(location.uri, location.range, newName);
        }

        // 查找并替换所有作为父类的继承引用
        const inheritanceReferences = this.iniManager.inheritanceReferences.get(oldName) || [];
        for (const location of inheritanceReferences) {
            workspaceEdit.replace(location.uri, location.range, newName);
        }

        return workspaceEdit;
    }

    /**
     * 获取给定位置的节名称的精确范围。
     */
    private getSectionNameRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
        const line = document.lineAt(position.line);
        const sectionMatch = line.text.match(/^\s*\[([^\]:]+)/);
        if (sectionMatch) {
            const sectionName = sectionMatch[1];
            const startIndex = line.text.indexOf(sectionName);
            const range = new vscode.Range(position.line, startIndex, position.line, startIndex + sectionName.length);
            if (range.contains(position)) {
                return range;
            }
        }
        return undefined;
    }
}