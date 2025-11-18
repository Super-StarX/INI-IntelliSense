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
        return context.diagnostics
            .filter(diagnostic => diagnostic instanceof IniDiagnostic)
            .map(diagnostic => this.createFixAction(document, diagnostic as IniDiagnostic))
            .filter(action => action !== undefined) as vscode.CodeAction[];
    }
    
    private createFixAction(document: vscode.TextDocument, diagnostic: IniDiagnostic): vscode.CodeAction | undefined {
        const edit = new vscode.WorkspaceEdit();
        let action: vscode.CodeAction;

        switch(diagnostic.errorCode) {
            case ErrorCode.STYLE_LEADING_WHITESPACE:
                action = new vscode.CodeAction(localize('codeaction.fix.leadingWhitespace', 'Remove unnecessary leading whitespace'), vscode.CodeActionKind.QuickFix);
                edit.delete(document.uri, diagnostic.range);
                break;
            case ErrorCode.STYLE_SPACE_BEFORE_EQUALS:
                action = new vscode.CodeAction(localize('codeaction.fix.spaceBeforeEquals', 'Remove spaces before \'=\''), vscode.CodeActionKind.QuickFix);
                edit.delete(document.uri, diagnostic.range);
                break;
            case ErrorCode.STYLE_SPACE_AFTER_EQUALS:
                action = new vscode.CodeAction(localize('codeaction.fix.spaceAfterEquals', 'Remove spaces after \'=\''), vscode.CodeActionKind.QuickFix);
                edit.delete(document.uri, diagnostic.range);
                break;
            case ErrorCode.STYLE_MISSING_SPACE_AFTER_COMMENT:
                action = new vscode.CodeAction(localize('codeaction.fix.spaceAfterComment', 'Add space after \';\''), vscode.CodeActionKind.QuickFix);
                edit.insert(document.uri, diagnostic.range.start.translate(0, 1), ' ');
                break;
            case ErrorCode.STYLE_INCORRECT_SPACES_BEFORE_COMMENT:
                const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
                const requiredSpaces = config.get<number>('spacesBeforeComment', 1);
                const title = localize('codeaction.fix.spacesBeforeComment', 'Fix spaces before comment to be {0}', requiredSpaces);
                action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                edit.replace(document.uri, diagnostic.range, ' '.repeat(requiredSpaces));
                break;
            default:
                return undefined;
        }

        action.diagnostics = [diagnostic];
        action.edit = edit;
        action.isPreferred = true;
        return action;
    }
}