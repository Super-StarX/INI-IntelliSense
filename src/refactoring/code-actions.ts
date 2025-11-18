import * as vscode from 'vscode';
import { ErrorCode } from '../diagnostics/error-codes';
import { IniDiagnostic } from '../diagnostics/diagnostic';
import { INIManager } from '../parser';
import { SchemaManager } from '../schema-manager';
import { localize } from '../i18n';

/**
 * 提供与诊断问题相关的代码操作（快速修复）。
 */
export class IniCodeActionProvider implements vscode.CodeActionProvider {

    constructor(private iniManager: INIManager, private schemaManager: SchemaManager) {}

    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        const actions: vscode.CodeAction[] = [];
        
        for (const diagnostic of context.diagnostics) {
            if (diagnostic instanceof IniDiagnostic && diagnostic.errorCode === ErrorCode.LOGIC_UNREGISTERED_SECTION) {
                actions.push(this.createRegisterSectionAction(document, diagnostic));
            }
        }

        return actions;
    }

    private createRegisterSectionAction(document: vscode.TextDocument, diagnostic: IniDiagnostic): vscode.CodeAction {
        const action = new vscode.CodeAction(localize('codeaction.registerSection', 'Register this section ID'), vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        
        action.command = {
            command: 'ra2-ini-intellisense.internal.registerSection',
            title: localize('codeaction.registerSection.title', 'Register Section ID'),
            arguments: [document.uri, diagnostic.range]
        };

        return action;
    }
}

/**
 * 注册并实现代码操作背后的命令逻辑。
 * 将复杂逻辑放在命令中，可以保持 CodeActionProvider 的简洁性。
 */
export function registerCodeActionCommands(iniManager: INIManager, schemaManager: SchemaManager) {
    vscode.commands.registerCommand('ra2-ini-intellisense.internal.registerSection', async (uri: vscode.Uri, range: vscode.Range) => {
        const document = await vscode.workspace.openTextDocument(uri);
        const sectionName = document.getText(range);
        
        const typeName = iniManager.getTypeForSection(sectionName);
        if (!typeName || !schemaManager.isComplexType(typeName)) {
            vscode.window.showErrorMessage(localize('codeaction.registerSection.error.noType', 'Cannot determine the type for section "[{0}]".', sectionName));
            return;
        }

        const registryName = schemaManager.getRegistryForType(typeName);
        if (!registryName) {
            vscode.window.showErrorMessage(localize('codeaction.registerSection.error.noRegistry', 'No registry list found for type "{0}" in the schema.', typeName));
            return;
        }

        const registryLocation = iniManager.findSectionLocations(registryName)[0];
        if (!registryLocation) {
            vscode.window.showErrorMessage(localize('codeaction.registerSection.error.registryNotFound', 'Cannot find the registry section "[{0}]" in the workspace.', registryName));
            return;
        }

        const registryDoc = await vscode.workspace.openTextDocument(registryLocation.uri);
        const registryContent = registryDoc.getText();
        const sectionRange = iniManager.findSectionRange(registryContent, registryName);

        if (!sectionRange) {
            return;
        }

        const lines = registryContent.substring(registryDoc.offsetAt(sectionRange.start), registryDoc.offsetAt(sectionRange.end)).split(/\r?\n/);
        let maxIndex = -1;
        for (const line of lines) {
            const match = line.trim().match(/^(\d+)\s*=/);
            if (match) {
                const index = parseInt(match[1], 10);
                if (index > maxIndex) {
                    maxIndex = index;
                }
            }
        }
        
        const newIndex = maxIndex + 1;
        const textToInsert = `${newIndex}=${sectionName}\n`;
        
        const edit = new vscode.WorkspaceEdit();
        // 插入到注册表节的最后一行之前
        edit.insert(registryLocation.uri, sectionRange.end, textToInsert);
        
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage(localize('codeaction.registerSection.success', 'Successfully registered "[{0}]" in "[{1}]" with index {2}.', sectionName, registryName, newIndex));
    });
}