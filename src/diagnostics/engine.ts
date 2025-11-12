import * as vscode from 'vscode';
import { IniDiagnostic } from './diagnostic';
import { ErrorCode } from './error-codes';
import { ValidationRule } from './rules';
import { SchemaManager } from '../schema-manager';
import { INIManager } from '../parser';
import { styleRules } from './rules/style-rules';
import { typeRules } from './rules/type-rules';

/**
 * 诊断上下文，为每个验证规则提供所需的所有信息。
 */
export interface DiagnosticContext {
    document: vscode.TextDocument;
    schemaManager: SchemaManager;
    iniManager: INIManager;
    config: vscode.WorkspaceConfiguration;
    disabledErrorCodes: Set<ErrorCode>;
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
            ...typeRules
        ];
    }

    /**
     * 对文档的指定范围或整个文档进行分析，并返回所有诊断信息。
     * @param context 包含文档、管理器和配置的上下文对象
     * @param rangeToAnalyze 可选参数，如果提供，则只分析此范围内的行
     * @returns 一个包含所有发现的诊断问题的数组
     */
    public analyze(context: DiagnosticContext, rangeToAnalyze?: vscode.Range): IniDiagnostic[] {
        const { document, disabledErrorCodes, config } = context;
        if (!config.get<boolean>('enabled', true)) {
            return [];
        }
        
        const allDiagnostics: IniDiagnostic[] = [];

        const startLine = rangeToAnalyze ? rangeToAnalyze.start.line : 0;
        const endLine = rangeToAnalyze ? rangeToAnalyze.end.line : document.lineCount - 1;

        // --- 性能优化：在单次遍历中维护状态 ---
        let currentSectionName: string | null = null;
        let currentTypeName: string | null = null;
        let currentKeys: Map<string, string> | null = null;

        // 为增量分析确定初始上下文：从分析范围的起始行向上查找最近的节。
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
            
            // 更新当前节的上下文
            const sectionMatch = line.text.match(/^\s*\[([^\]:]+)/);
            if (sectionMatch) {
                currentSectionName = sectionMatch[1].trim();
                currentTypeName = context.iniManager.getTypeForSection(currentSectionName);
                currentKeys = currentTypeName ? context.schemaManager.getAllKeysForType(currentTypeName) : null;
            }

            const lineContext = {
                ...context,
                line,
                lineNumber: i,
                currentSection: {
                    name: currentSectionName,
                    typeName: currentTypeName,
                    keys: currentKeys
                }
            };
            
            // 依次执行每个规则
            for (const rule of this.rules) {
                const diagnostics = rule(lineContext);
                allDiagnostics.push(...diagnostics);
            }
        }

        // 过滤掉被用户禁用的错误码
        return allDiagnostics.filter(d => !disabledErrorCodes.has(d.errorCode));
    }
}