import * as vscode from 'vscode';
import { IniDiagnostic } from '../diagnostic';
import { ErrorCode } from '../error-codes';
import { RuleContext, ValidationRule } from '../rules';
import { ValueTypeCategory } from '../../schema-manager';

/**
 * 验证一个值是否符合其 Schema 定义的类型规则，并返回带精确范围的错误。
 * @param value 要验证的字符串值
 * @param valueType 值的预期类型 (来自 Schema)
 * @param context 完整的诊断上下文
 * @param valueStartIndex 完整值字符串在行中的起始位置
 * @returns 一个包含所有验证错误的数组，如果验证成功，则返回空数组
 */
function validateValue(value: string, valueType: string, context: RuleContext, valueStartIndex: number): IniDiagnostic[] {
    const { schemaManager, iniManager, lineNumber } = context;
    const category = schemaManager.getValueTypeCategory(valueType);
    const fullRange = new vscode.Range(lineNumber, valueStartIndex, lineNumber, valueStartIndex + value.length);

    const createError = (message: string, code: ErrorCode, range: vscode.Range = fullRange): IniDiagnostic[] => {
        return [new IniDiagnostic(range, message, vscode.DiagnosticSeverity.Error, code)];
    };

    switch (category) {
        case ValueTypeCategory.Primitive:
            if (valueType === 'int' && !/^-?\d+$/.test(value)) {return createError(`值 "${value}" 不是一个有效的整数。`, ErrorCode.TYPE_INVALID_INTEGER);}
            if (valueType === 'float' && isNaN(parseFloat(value))) {return createError(`值 "${value}" 不是一个有效的浮点数。`, ErrorCode.TYPE_INVALID_FLOAT);}
            return [];

        case ValueTypeCategory.NumberLimit: {
            const limit = schemaManager.getNumberLimit(valueType);
            if (!limit) {return [];}
            const num = parseInt(value, 10);
            if (isNaN(num)) {return createError(`值 "${value}" 不是一个有效的整数。`, ErrorCode.TYPE_INVALID_INTEGER);}
            if (num < limit.min || num > limit.max) {
                return createError(`值 ${value} 超出类型 '${valueType}' 的范围 [${limit.min}, ${limit.max}]。`, ErrorCode.TYPE_NUMBER_OUT_OF_RANGE);
            }
            return [];
        }

        case ValueTypeCategory.StringLimit: {
            const limit = schemaManager.getStringLimit(valueType);
            if (!limit) {return [];}
            const compareValue = limit.caseSensitive ? value : value.toLowerCase();

            if (limit.limitIn) {
                const allowed = limit.caseSensitive ? limit.limitIn : limit.limitIn.map(v => v.toLowerCase());
                if (!allowed.includes(compareValue)) {return createError(`值 "${value}" 不是类型 '${valueType}' 允许的值之一。`, ErrorCode.TYPE_VALUE_NOT_IN_LIST);}
            }
            if (limit.startWith) {
                const prefixes = limit.caseSensitive ? limit.startWith : limit.startWith.map(v => v.toLowerCase());
                if (!prefixes.some(p => compareValue.startsWith(p))) {return createError(`值 "${value}" 不符合类型 '${valueType}' 的前缀要求。`, ErrorCode.TYPE_INVALID_PREFIX);}
            }
            if (limit.endWith) {
                const suffixes = limit.caseSensitive ? limit.endWith : limit.endWith.map(v => v.toLowerCase());
                if (!suffixes.some(s => compareValue.endsWith(s))) {return createError(`值 "${value}" 不符合类型 '${valueType}' 的后缀要求。`, ErrorCode.TYPE_INVALID_SUFFIX);}
            }
            return [];
        }

        case ValueTypeCategory.List: {
            const definition = schemaManager.getListDefinition(valueType);
            if (!definition) {return [];}
            
            const items = value ? value.split(',').map(item => item.trim()) : [];

            if (definition.minRange !== undefined && items.length < definition.minRange) {return createError(`类型 '${valueType}' 要求至少 ${definition.minRange} 个值，但只提供了 ${items.length} 个。`, ErrorCode.TYPE_LIST_INVALID_LENGTH);}
            if (definition.maxRange !== undefined && items.length > definition.maxRange) {return createError(`类型 '${valueType}' 要求最多 ${definition.maxRange} 个值，但提供了 ${items.length} 个。`, ErrorCode.TYPE_LIST_INVALID_LENGTH);}
            
            const allErrors: IniDiagnostic[] = [];
            let currentOffsetInValue = 0;
            const originalItems = value ? value.split(',') : [];

            for (let i = 0; i < originalItems.length; i++) {
                const originalItem = originalItems[i];
                const trimmedItem = originalItem.trim();
                
                const itemStartIndexInLine = valueStartIndex + currentOffsetInValue + originalItem.indexOf(trimmedItem);

                const itemErrors = validateValue(trimmedItem, definition.type, context, itemStartIndexInLine);
                if (itemErrors.length > 0) {
                    itemErrors.forEach(err => {
                        err.message = `列表项 "${trimmedItem}" 无效: ${err.message}`;
                        allErrors.push(err);
                    });
                }
                currentOffsetInValue += originalItem.length + 1; // +1 for comma
            }
            return allErrors;
        }

        case ValueTypeCategory.Section:
            if (iniManager.findSection(value) === null) {
                return createError(`未在项目中找到节 '[${value}]' 的定义。`, ErrorCode.LOGIC_UNDEFINED_SECTION_REFERENCE);
            }
            return [];
            
        default:
            return [];
    }
}

const checkKeyValueTypes: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { line, currentSection } = context;

    const kvMatch = line.text.match(/^\s*([^;=\s][^=]*?)\s*=\s*(.*)/);
    if (!kvMatch || !currentSection.keys) {
        return [];
    }
    
    const key = kvMatch[1].trim();
    const valueString = kvMatch[2].split(';')[0].trim();
    
    let valueType: string | undefined;
    for (const [k, v] of currentSection.keys.entries()) {
        if (k.toLowerCase() === key.toLowerCase()) {
            valueType = v;
            break;
        }
    }

    if (valueType) {
        // 计算值在行中的精确起始位置
        const valueStartIndex = line.text.indexOf(kvMatch[2]) + (kvMatch[2].length - kvMatch[2].trimStart().length);
        return validateValue(valueString, valueType, context, valueStartIndex);
    }
    
    return [];
};


export const typeRules: ValidationRule[] = [
    checkKeyValueTypes
];