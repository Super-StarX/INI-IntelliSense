import * as vscode from 'vscode';
import { IniDiagnostic } from '../diagnostic';
import { ErrorCode } from '../error-codes';
import { RuleContext, ValidationRule } from '../rules';
import { localize } from '../../i18n';

const checkLeadingWhitespace: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { line, lineNumber, config } = context;
    if (!config.get<boolean>('leadingWhitespace', true) || line.isEmptyOrWhitespace) {
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
    const { codePart, lineNumber, config } = context;
    const diagnostics: IniDiagnostic[] = [];

    // 检查等号前的空格，此项检查不受值是否为空的影响
    if (config.get<boolean>('spaceBeforeEquals', true)) {
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

    // 检查等号后的空格
    if (config.get<boolean>('spaceAfterEquals', true)) {
        const equalsIndex = codePart.indexOf('=');
        if (equalsIndex !== -1) {
            const valuePart = codePart.substring(equalsIndex + 1);

            // 如果值部分在去除空格后为空，则不报告“等号后有空格”的风格问题。
            // 这将优先权让给 LOGIC_EMPTY_VALUE 规则。
            if (valuePart.trim() === '') {
                return diagnostics; // 提前返回，不检查等号后的空格
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

    const spacesBeforeComment = config.get<number | null>('spacesBeforeComment', 1);
    if (spacesBeforeComment !== null && codePart.trim().length > 0) {
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

    if (config.get<boolean>('spaceAfterComment', true)) {
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