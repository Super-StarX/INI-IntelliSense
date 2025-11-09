import * as ini from 'ini';

interface SchemaDefinition {
    keys: Map<string, string>; // key -> valueType
    base: string | null;
}

/**
 * 管理和解析 INICodingCheck.ini 文件的核心类
 * 提供了基于类型继承获取所有合法键的功能
 */
export class SchemaManager {
    // 映射注册表节名 (如 'BuildingTypes') 到其对应的 schema 类型名 (如 'BuildingType')
    private registries = new Map<string, string>();
    // 存储所有 schema 类型 (如 'BuildingType') 的详细定义 (键和基类)
    private schemas = new Map<string, SchemaDefinition>();
    // 缓存已计算的类型键集合, 避免重复进行继承链的遍历, 提高性能
    private keyCache = new Map<string, Map<string, string>>();

    /**
     * 清空所有已加载的 schema 数据
     */
    public clearSchema() {
        this.registries.clear();
        this.schemas.clear();
        this.keyCache.clear();
    }

    /**
     * 加载并解析 schema 文件的内容
     * @param content INICodingCheck.ini 文件的字符串内容
     */
    public loadSchema(content: string) {
        // 在加载新 schema 前先清空旧数据, 保证状态干净
        this.clearSchema();
        const parsedSchema = ini.parse(content);

        // 1. 解析 [Registries] 节, 建立注册表到类型的映射
        if (parsedSchema.Registries) {
            for (const [key, value] of Object.entries(parsedSchema.Registries)) {
                if (typeof value === 'string') {
                    this.registries.set(key, value);
                }
            }
        }

        // 2. 解析所有类型定义节
        // 我们不依赖 [Sections] 节, 而是直接遍历所有节来构建类型定义
        // 这样更健壮, 即使 [Sections] 缺失或不完整也能工作
        for (const sectionKey of Object.keys(parsedSchema)) {
            // 跳过非类型定义的元数据节
            if (['Registries', 'Globals', 'Sections', 'NumberLimits', 'Limits', 'Lists'].includes(sectionKey)) {
                // 针对 [Animations] 这种既是注册表又是元数据的特殊情况, 允许继续处理
                if (!this.registries.has(sectionKey)) {
                    continue;
                }
            }

            const sectionData = parsedSchema[sectionKey];
            if (typeof sectionData !== 'object' || sectionData === null) {
                continue;
            }

            const parts = sectionKey.split(':');
            const typeName = parts[0].trim();
            const baseName = parts.length > 1 ? parts[1].trim() : null;

            // 如果该类型已存在(可能来自不带继承的定义), 则更新其基类
            const definition = this.schemas.get(typeName) ?? { keys: new Map(), base: null };
            if (baseName) {
                definition.base = baseName;
            }

            for (const [key, valueType] of Object.entries(sectionData)) {
                if (typeof valueType === 'string') {
                    // 处理动态键, 如 'Weapon(1,WeaponCount)' -> 'Weapon'
                    const keyName = key.split('(')[0].trim();
                    definition.keys.set(keyName, valueType);
                }
            }
            this.schemas.set(typeName, definition);
        }
    }

    /**
     * 根据注册表名获取其对应的类型名
     * @param registryName 注册表名, 如 'BuildingTypes'
     * @returns 类型名, 如 'BuildingType'
     */
    public getTypeForRegistry(registryName: string): string | undefined {
        return this.registries.get(registryName);
    }

    /**
     * 获取指定类型的所有合法键, 包括从所有基类继承的键
     * @param typeName 类型名, 如 'BuildingType'
     * @returns 一个包含所有键及其值类型的 Map
     */
    public getAllKeysForType(typeName: string): Map<string, string> {
        // 优先从缓存中读取, 避免重复计算
        if (this.keyCache.has(typeName)) {
            return this.keyCache.get(typeName)!;
        }

        const schema = this.schemas.get(typeName);
        if (!schema) {
            return new Map();
        }

        // 递归地获取基类的所有键
        const baseKeys = schema.base ? this.getAllKeysForType(schema.base) : new Map();

        // 合并基类的键和当前类型的键 (子类键会覆盖父类同名键)
        const allKeys = new Map([...baseKeys, ...schema.keys]);

        // 将计算结果存入缓存
        this.keyCache.set(typeName, allKeys);
        return allKeys;
    }
}