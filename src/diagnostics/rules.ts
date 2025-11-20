// src/diagnostics/rules.ts
import * as vscode from 'vscode';
import { IniDiagnostic } from './diagnostic';
import { DiagnosticContext } from './engine';

/**
 * 验证规则执行的上下文，包含当前行的详细信息。
 */
export interface RuleContext extends DiagnosticContext {
    line: vscode.TextLine;
    lineNumber: number;
    codePart: string;
    commentPart: string | null;
    currentSection: {
        name: string | null;
        typeName: string | null;
        keys: Map<string, any> | null;
    };
}

/**
 * 定义一个验证规则函数的类型签名。
 * 每个规则接收上下文并返回一个诊断数组。
 */
export type ValidationRule = (context: RuleContext) => IniDiagnostic[];