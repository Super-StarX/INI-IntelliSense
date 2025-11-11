import * as vscode from 'vscode';
import { ErrorCode } from './error-codes';

/**
 * 扩展的自定义诊断类。
 * 它继承自 vscode.Diagnostic，并额外携带了唯一的错误码。
 * 这使得代码的其他部分（如 CodeActionProvider）可以根据错误码精确地识别错误类型。
 */
export class IniDiagnostic extends vscode.Diagnostic {
    public readonly errorCode: ErrorCode;

    constructor(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity, errorCode: ErrorCode) {
        super(range, message, severity);
        this.errorCode = errorCode;
        // 将错误码赋值给 diagnostic 的 code 属性，VS Code 会在UI上显示它
        this.code = errorCode;
    }
}