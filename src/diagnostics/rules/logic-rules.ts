import * as vscode from 'vscode';
import { IniDiagnostic } from '../diagnostic';
import { ErrorCode } from '../error-codes';
import { RuleContext, ValidationRule } from '../rules';
import { localize } from '../../i18n';

const checkUnregisteredSection: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    // 暂不启用此检查，因为判定逻辑复杂且容易误报。
    // 将通过上下文菜单提供一个更主动、可控的注册方式。
    return [];
    /*
    const { line, lineNumber, schemaManager, iniManager } = context;
    const sectionMatch = line.text.match(/^\s*\[([^\]:]+)/);

    if (sectionMatch) {
        const sectionName = sectionMatch[1].trim();
        const typeName = iniManager.getTypeForSection(sectionName);
        
        // 仅当此节是一个复杂的对象类型时才检查注册
        if (schemaManager.isComplexType(typeName)) {
            // 检查此节是否已在任何注册表中注册
            const registry = iniManager.findRegistryForSection(sectionName);
            if (!registry) {
                const range = new vscode.Range(lineNumber, line.text.indexOf(sectionName), lineNumber, line.text.indexOf(sectionName) + sectionName.length);
                return [new IniDiagnostic(
                    range,
                    localize('diag.logic.unregisteredSection', 'Section "[{0}]" appears to be of type "{1}" but is not registered in any ID list (e.g., [{2}]).', sectionName, typeName, schemaManager.getRegistryForType(typeName) || '...Types'),
                    vscode.DiagnosticSeverity.Warning,
                    ErrorCode.LOGIC_UNREGISTERED_SECTION
                )];
            }
        }
    }

    return [];
    */
};

const checkEmptyValue: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { line, codePart } = context;

    const kvMatch = codePart.match(/^\s*([^;=\s][^=]*?)\s*=(.*)/);
    if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();

        if (value === '') {
            return [new IniDiagnostic(
                line.range,
                localize('diag.logic.emptyValue', "The key '{0}' has an empty value.", key),
                vscode.DiagnosticSeverity.Warning,
                ErrorCode.LOGIC_EMPTY_VALUE
            )];
        }
    }
    
    return [];
};

const checkDuplicateRegistryKey: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { codePart, currentSection, schemaManager, seenRegistryKeys, lineNumber } = context;

    if (!currentSection.name) { return []; }

    // 检查该节是否是一个“ID列表注册表”（如 BuildingTypes）
    if (!schemaManager.getIdListRegistryNames().has(currentSection.name)) {
        return [];
    }

    // 匹配 Key=Value 结构
    const kvMatch = codePart.match(/^\s*([^;=\s][^=]*?)\s*=/);
    if (kvMatch) {
        const key = kvMatch[1].trim();

        // Ares 的 "+" 键允许重复，不做检查
        if (key === '+') {
            return [];
        }

        // 检查重复
        if (seenRegistryKeys.has(key)) {
            const keyIndex = codePart.indexOf(key);
            const range = new vscode.Range(lineNumber, keyIndex, lineNumber, keyIndex + key.length);
            
            return [new IniDiagnostic(
                range,
                localize('diag.logic.duplicateRegistryKey', "Duplicate registry key '{0}'. This will overwrite the previous entry.", key),
                vscode.DiagnosticSeverity.Warning,
                ErrorCode.LOGIC_DUPLICATE_REGISTRY_KEY
            )];
        }

        // 6. 记录该键
        seenRegistryKeys.add(key);
    }

    return [];
};

export const logicRules: ValidationRule[] = [
    checkUnregisteredSection,
    checkEmptyValue,
    checkDuplicateRegistryKey,
];