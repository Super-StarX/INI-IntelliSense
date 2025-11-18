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

    if (config.get<boolean>('spaceAfterEquals', true)) {
        const equalsRight = codePart.match(/=(\s+)/);
        if (equalsRight) {
            const start = codePart.indexOf(equalsRight[0]) + 1;
            diagnostics.push(new IniDiagnostic(
                new vscode.Range(lineNumber, start, lineNumber, start + equalsRight[1].length),
                localize('diag.style.spaceAfterEquals', 'Avoid spaces after the "=" sign.'),
                vscode.DiagnosticSeverity.Warning,
                ErrorCode.STYLE_SPACE_AFTER_EQUALS
            ));
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