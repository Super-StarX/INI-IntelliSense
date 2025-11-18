// src/diagnostics/error-codes.ts
/**
 * 定义所有诊断错误的唯一错误码。
 * 这种方法有助于对错误进行分类，并为将来的快速修复等功能提供稳定的标识符。
 * - STYLE (1xx): 代码风格问题
 * - TYPE (2xx):  键值类型不匹配问题
 * - LOGIC (3xx): 逻辑有效性问题 (如引用不存在)
 */
export enum ErrorCode {
    // Style Errors (1xx)
    STYLE_LEADING_WHITESPACE = 'STYLE-101',
    STYLE_SPACE_BEFORE_EQUALS = 'STYLE-102',
    STYLE_SPACE_AFTER_EQUALS = 'STYLE-103',
    STYLE_INCORRECT_SPACES_BEFORE_COMMENT = 'STYLE-104',
    STYLE_MISSING_SPACE_AFTER_COMMENT = 'STYLE-105',

    // Type Errors (2xx)
    TYPE_INVALID_INTEGER = 'TYPE-201',
    TYPE_INVALID_FLOAT = 'TYPE-202',
    TYPE_NUMBER_OUT_OF_RANGE = 'TYPE-203',
    TYPE_VALUE_NOT_IN_LIST = 'TYPE-204',
    TYPE_INVALID_PREFIX = 'TYPE-205',
    TYPE_INVALID_SUFFIX = 'TYPE-206',
    TYPE_LIST_INVALID_LENGTH = 'TYPE-207',

    // Logic Errors (3xx)
    LOGIC_UNDEFINED_SECTION_REFERENCE = 'LOGIC-301',
    LOGIC_UNREGISTERED_SECTION = 'LOGIC-302',
    LOGIC_EMPTY_VALUE = 'LOGIC-303',
}