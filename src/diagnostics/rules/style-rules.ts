import * as vscode from 'vscode';
import { IniDiagnostic } from '../diagnostic';
import { ErrorCode } from '../error-codes';
import { RuleContext, ValidationRule } from '../rules';
import { localize } from '../../i18n';

// 辅助函数：检查规则是否被禁用 (severity === null)
function isRuleEnabled(context: RuleContext, code: ErrorCode): boolean {
    const override = context.severityOverrides.get(code);
    // 如果 override 明确为 null，说明被禁用（无论是通过 severity 配置还是旧开关转换而来）
    if (override === null) {
        return false;
    }
    // 还要检查旧的 disable 数组
    if (context.disabledErrorCodes.has(code)) {
        return false;
    }
    return true;
}

const checkLeadingWhitespace: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { line, lineNumber } = context;
    
    if (!isRuleEnabled(context, ErrorCode.STYLE_LEADING_WHITESPACE) || line.isEmptyOrWhitespace) {
        return [];
    }

    const leadingSpaceMatch = line.text.match(/^\s+/);
    if (leadingSpaceMatch && line.text.trim() !== '') {
        return [new IniDiagnostic(
            new vscode.Range(lineNumber, 0, lineNumber, leadingSpaceMatch[0].length),
            localize('diag.style.leadingWhitespace', 'Unnecessary leading whitespace at the beginning of the line.'),
            vscode.DiagnosticSeverity.Warning,
            ErrorCode.STYLE_LEADING_WHITESPACE
        )];
    }
    return [];
};

const checkSpaceAroundEquals: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { codePart, lineNumber } = context;
    const diagnostics: IniDiagnostic[] = [];

    if (isRuleEnabled(context, ErrorCode.STYLE_SPACE_BEFORE_EQUALS)) {
        const equalsLeft = codePart.match(/(\s+)=/);
        if (equalsLeft) {
            const start = codePart.indexOf(equalsLeft[0]);
            diagnostics.push(new IniDiagnostic(
                new vscode.Range(lineNumber, start, lineNumber, start + equalsLeft[1].length),
                localize('diag.style.spaceBeforeEquals', 'Avoid spaces before the "=" sign.'),
                vscode.DiagnosticSeverity.Warning,
                ErrorCode.STYLE_SPACE_BEFORE_EQUALS
            ));
        }
    }

    if (isRuleEnabled(context, ErrorCode.STYLE_SPACE_AFTER_EQUALS)) {
        const equalsIndex = codePart.indexOf('=');
        if (equalsIndex !== -1) {
            const valuePart = codePart.substring(equalsIndex + 1);
            if (valuePart.trim() === '') {
                return diagnostics;
            }
            const equalsRight = valuePart.match(/^\s+/);
            if (equalsRight) {
                const start = equalsIndex + 1;
                diagnostics.push(new IniDiagnostic(
                    new vscode.Range(lineNumber, start, lineNumber, start + equalsRight[0].length),
                    localize('diag.style.spaceAfterEquals', 'Avoid spaces after the "=" sign.'),
                    vscode.DiagnosticSeverity.Warning,
                    ErrorCode.STYLE_SPACE_AFTER_EQUALS
                ));
            }
        }
    }

    return diagnostics;
};

const checkCommentSpacing: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { line, lineNumber, config, codePart, commentPart } = context;
    if (commentPart === null) {
        return [];
    }
    
    const diagnostics: IniDiagnostic[] = [];
    const commentStartIndex = codePart.length;

    // 注意：spacesBeforeComment 是一个数值配置，不是开关，所以这里保留 config 读取
    const spacesBeforeComment = config.get<number | null>('spacesBeforeComment', 1);
    if (isRuleEnabled(context, ErrorCode.STYLE_INCORRECT_SPACES_BEFORE_COMMENT) && 
        spacesBeforeComment !== null && codePart.trim().length > 0) {
        
        const trailingSpacesMatch = codePart.match(/(\s+)$/);
        const numSpaces = trailingSpacesMatch ? trailingSpacesMatch[1].length : 0;
        
        if (numSpaces !== spacesBeforeComment) {
            diagnostics.push(new IniDiagnostic(
                new vscode.Range(lineNumber, commentStartIndex - numSpaces, lineNumber, commentStartIndex),
                localize('diag.style.incorrectSpacesBeforeComment', 'There should be {0} space(s) before the comment character ";".', spacesBeforeComment),
                vscode.DiagnosticSeverity.Warning,
                ErrorCode.STYLE_INCORRECT_SPACES_BEFORE_COMMENT
            ));
        }
    }

    if (isRuleEnabled(context, ErrorCode.STYLE_MISSING_SPACE_AFTER_COMMENT)) {
        if (commentPart.length > 1 && commentPart.charAt(1) !== ' ') {
            diagnostics.push(new IniDiagnostic(
                new vscode.Range(lineNumber, commentStartIndex, lineNumber, commentStartIndex + 1),
                localize('diag.style.missingSpaceAfterComment', 'There should be a space after the comment character ";".'),
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