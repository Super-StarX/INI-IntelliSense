import * as vscode from 'vscode';
import { IniDiagnostic } from './diagnostic';
import { ErrorCode } from './error-codes';
import { ValidationRule } from './rules';
import { SchemaManager } from '../schema-manager';
import { INIManager } from '../parser';
import { styleRules } from './rules/style-rules';
import { typeRules } from './rules/type-rules';
import { logicRules } from './rules/logic-rules';

// 辅助函数：将字符串转换为 vscode.DiagnosticSeverity
function parseSeverity(level: string): vscode.DiagnosticSeverity | null {
    switch (level.toLowerCase()) {
        case 'error': return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'information': return vscode.DiagnosticSeverity.Information;
        case 'hint': return vscode.DiagnosticSeverity.Hint;
        case 'none': return null; // 特殊标记，表示禁用
        default: return vscode.DiagnosticSeverity.Warning; // 默认回退
    }
}

/**
 * 诊断上下文，为每个验证规则提供所需的所有信息。
 */
export interface DiagnosticContext {
    document: vscode.TextDocument;
    schemaManager: SchemaManager;
    iniManager: INIManager;
    config: vscode.WorkspaceConfiguration;
    disabledErrorCodes: Set<string>;
    severityOverrides: Map<string, vscode.DiagnosticSeverity | null>;
    outputChannel: vscode.OutputChannel;
}

/**
 * 诊断引擎，负责管理和执行一系列独立的验证规则。
 * 这种设计将验证逻辑与主扩展文件解耦，提高了可维护性和可扩展性。
 */
export class DiagnosticEngine {
    private rules: ValidationRule[];

    constructor() {
        // 在此注册所有验证规则
        this.rules = [
            ...styleRules,
            ...typeRules,
            ...logicRules
        ];
    }

    /**
     * 对文档的指定范围或整个文档进行分析，并返回所有诊断信息。
     * @param context 包含文档、管理器和配置的上下文对象
     * @param rangeToAnalyze 可选参数，如果提供，则只分析此范围内的行
     * @returns 一个包含所有发现的诊断问题的数组
     */
    public analyze(context: DiagnosticContext, rangeToAnalyze?: vscode.Range): IniDiagnostic[] {
        const { document, disabledErrorCodes, severityOverrides, config, outputChannel } = context;
        
        if (!config.get<boolean>('enabled', true)) {
            return [];
        }
        
        const allDiagnostics: IniDiagnostic[] = [];
        const startLine = rangeToAnalyze ? rangeToAnalyze.start.line : 0;
        const endLine = rangeToAnalyze ? rangeToAnalyze.end.line : document.lineCount - 1;

        // --- 性能优化：上下文构建 ---
        let currentSectionName: string | null = null;
        let currentTypeName: string | null = null;
        let currentKeys: Map<string, any> | null = null;
        let currentSeenRegistryKeys = new Set<string>();

        if (startLine > 0) {
            for (let i = startLine - 1; i >= 0; i--) {
                const line = document.lineAt(i);
                const sectionMatch = line.text.match(/^\s*\[([^\]:]+)/);
                if (sectionMatch) {
                    currentSectionName = sectionMatch[1].trim();
                    currentTypeName = context.iniManager.getTypeForSection(currentSectionName);
                    currentKeys = currentTypeName ? context.schemaManager.getAllKeysForType(currentTypeName) : null;
                    break;
                }
            }
        }

        for (let i = startLine; i <= endLine && i < document.lineCount; i++) {
            const line = document.lineAt(i);
            
            const commentIndex = line.text.indexOf(';');
            const codePart = commentIndex === -1 ? line.text : line.text.substring(0, commentIndex);
            const commentPart = commentIndex === -1 ? null : line.text.substring(commentIndex);

            const sectionMatch = codePart.match(/^\s*\[([^\]:]+)/);
            if (sectionMatch) {
                currentSectionName = sectionMatch[1].trim();
                currentTypeName = context.iniManager.getTypeForSection(currentSectionName);
                currentKeys = currentTypeName ? context.schemaManager.getAllKeysForType(currentTypeName) : null;
                currentSeenRegistryKeys.clear();
            }

            const lineContext = {
                ...context,
                line,
                lineNumber: i,
                codePart,
                commentPart,
                currentSection: {
                    name: currentSectionName,
                    typeName: currentTypeName,
                    keys: currentKeys
                },
                seenRegistryKeys: currentSeenRegistryKeys
            };
            
            for (const rule of this.rules) {
                const diagnostics = rule(lineContext);
                allDiagnostics.push(...diagnostics);
            }
        }

        const finalDiagnostics: IniDiagnostic[] = [];

        for (const diag of allDiagnostics) {
            const code = String(diag.errorCode);

            // 1. 检查 severityOverrides (优先级最高)
            if (severityOverrides.has(code)) {
                const override = severityOverrides.get(code);
                if (override === null) {
                    continue; // 等级为 None，跳过
                }
                if (override !== undefined) {
                    diag.severity = override; // 应用新的等级
                }
                finalDiagnostics.push(diag);
                continue;
            }

            // 2. 检查旧的 disabledErrorCodes (向后兼容)
            if (disabledErrorCodes.has(code)) {
                continue;
            }

            // 3. 默认情况
            finalDiagnostics.push(diag);
        }

        return finalDiagnostics;
    }
}