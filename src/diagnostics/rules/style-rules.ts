import * as vscode from 'vscode';
import { IniDiagnostic } from '../diagnostic';
import { ErrorCode } from '../error-codes';
import { RuleContext, ValidationRule } from '../rules';

const checkLeadingWhitespace: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { line, lineNumber, config } = context;
    if (!config.get<boolean>('leadingWhitespace', true) || line.isEmptyOrWhitespace) {
        return [];
    }

    const leadingSpaceMatch = line.text.match(/^\s+/);
    if (leadingSpaceMatch) {
        return [new IniDiagnostic(
            new vscode.Range(lineNumber, 0, lineNumber, leadingSpaceMatch[0].length),
            '行首存在不必要的空格。',
            vscode.DiagnosticSeverity.Warning,
            ErrorCode.STYLE_LEADING_WHITESPACE
        )];
    }
    return [];
};

const checkSpaceAroundEquals: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { line, lineNumber, config } = context;
    const diagnostics: IniDiagnostic[] = [];

    if (config.get<boolean>('spaceBeforeEquals', true)) {
        const equalsLeft = line.text.match(/(\s+)=/);
        if (equalsLeft) {
            const start = line.text.indexOf(equalsLeft[0]);
            diagnostics.push(new IniDiagnostic(
                new vscode.Range(lineNumber, start, lineNumber, start + equalsLeft[1].length),
                '请避免在 "=" 左侧使用空格。',
                vscode.DiagnosticSeverity.Warning,
                ErrorCode.STYLE_SPACE_BEFORE_EQUALS
            ));
        }
    }

    if (config.get<boolean>('spaceAfterEquals', true)) {
        const equalsRight = line.text.match(/=(\s+)/);
        if (equalsRight) {
            const start = line.text.indexOf(equalsRight[0]) + 1;
            diagnostics.push(new IniDiagnostic(
                new vscode.Range(lineNumber, start, lineNumber, start + equalsRight[1].length),
                '请避免在 "=" 右侧使用空格。',
                vscode.DiagnosticSeverity.Warning,
                ErrorCode.STYLE_SPACE_AFTER_EQUALS
            ));
        }
    }

    return diagnostics;
};

const checkCommentSpacing: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { line, lineNumber, config } = context;
    const diagnostics: IniDiagnostic[] = [];
    const lineText = line.text;
    const commentIndex = lineText.indexOf(';');

    if (commentIndex === -1) return [];

    const spacesBeforeComment = config.get<number | null>('spacesBeforeComment', 1);
    if (spacesBeforeComment !== null) {
        if (commentIndex > 0 && lineText.substring(0, commentIndex).trim().length > 0) {
            const precedingText = lineText.substring(0, commentIndex);
            const trailingSpacesMatch = precedingText.match(/(\s+)$/);
            const numSpaces = trailingSpacesMatch ? trailingSpacesMatch[1].length : 0;
            
            if (numSpaces !== spacesBeforeComment) {
                diagnostics.push(new IniDiagnostic(
                    new vscode.Range(lineNumber, commentIndex - numSpaces, lineNumber, commentIndex),
                    `注释符号 ";" 前应有 ${spacesBeforeComment} 个空格。`,
                    vscode.DiagnosticSeverity.Warning,
                    ErrorCode.STYLE_INCORRECT_SPACES_BEFORE_COMMENT
                ));
            }
        }
    }

    if (config.get<boolean>('spaceAfterComment', true)) {
        const commentRightMatch = lineText.match(/;\S/);
        if (commentRightMatch) {
            const start = lineText.indexOf(commentRightMatch[0]);
            diagnostics.push(new IniDiagnostic(
                new vscode.Range(lineNumber, start, lineNumber, start + 2),
                '注释符号 ";" 后应有一个空格。',
                vscode.DiagnosticSeverity.Warning,
                ErrorCode.STYLE_MISSING_SPACE_AFTER_COMMENT
            ));
        }
    }

    return diagnostics;
};


export const styleRules: ValidationRule[] = [
    checkLeadingWhitespace,
    checkSpaceAroundEquals,
    checkCommentSpacing,
];