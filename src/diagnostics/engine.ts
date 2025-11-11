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
     * 对整个文档进行分析，并返回所有诊断信息。
     * @param context 包含文档、管理器和配置的上下文对象
     * @returns 一个包含所有发现的诊断问题的数组
     */
    public analyze(context: DiagnosticContext): IniDiagnostic[] {
        const { document, disabledErrorCodes } = context;
        if (!context.config.get<boolean>('enabled', true)) {
            return [];
        }
        
        const allDiagnostics: IniDiagnostic[] = [];

        // --- 性能优化：在单次遍历中维护状态 ---
        let currentSectionName: string | null = null;
        let currentTypeName: string | null = null;
        let currentKeys: Map<string, string> | null = null;

        for (let i = 0; i < document.lineCount; i++) {
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