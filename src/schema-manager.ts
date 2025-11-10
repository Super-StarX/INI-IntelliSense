/**
 * 存储一个Schema类型的定义。
 */
interface SchemaDefinition {
    // 该类型自身定义的键。
    keys: Map<string, string>; // key -> valueType
    // 该类型的父类名称。
    base: string | null;
}

/**
 * 管理和解析 INICodingCheck.ini 文件的核心类。
 * 负责加载Schema文件，并提供基于类型继承获取所有合法键的功能。
 */
export class SchemaManager {
    // 映射注册表节名 (如 'BuildingTypes') 到其对应的 schema 类型名 (如 'BuildingType')。
    private registries = new Map<string, string>();
    // 映射 schema 类型名 (如 'AnimType') 到其对应的注册表节名 (如 'Animations')。
    private sections = new Map<string, string>();
    // 存储所有 schema 类型 (如 'BuildingType') 的详细定义 (键和基类)。
    private schemas = new Map<string, SchemaDefinition>();
    // 缓存已计算的类型键集合, 避免对同一类型的继承链进行重复遍历, 提高性能。
    private keyCache = new Map<string, Map<string, string>>();
    // 标记Schema文件是否已成功加载并解析。
    private isLoaded: boolean = false;
    // 存储在 [Sections] 中定义的复杂对象类型名称。
    private complexTypes: Set<string> = new Set(); 

    /**
     * 清空所有已加载的 schema 数据，重置状态。
     */
    public clearSchema() {
        this.registries.clear();
        this.sections.clear();
        this.schemas.clear();
        this.keyCache.clear();
        this.complexTypes.clear();
        this.isLoaded = false;
    }

    /**
     * 检查 schema 是否已成功加载。
     */
    public isSchemaLoaded(): boolean {
        return this.isLoaded;
    }

    /**
     * 手动逐行加载并解析 schema 文件的内容。
     * 采用两遍扫描法，第一遍建立结构，第二遍填充内容。
     * @param content INICodingCheck.ini 文件的字符串内容
     */
    public loadSchema(content: string) {
        this.clearSchema();
        
        const lines = content.split(/\r?\n/);
        
        // --- 第一遍扫描：识别所有节及其继承关系 ---
        // 临时的、用于存储文件结构的原始数据
        const preParsed = new Map<string, { base: string | null, contentLines: string[] }>();
        let currentSection: { base: string | null, contentLines: string[] } | null = null;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === '' || trimmedLine.startsWith(';')) continue;

            // 使用正则表达式匹配节头, 兼容 [TypeName] 和 [TypeName]:[BaseName] 两种格式
            const sectionMatch = trimmedLine.match(/^\[([^\]:]+)\](?::\[([^\]]+)\])?/);

            if (sectionMatch) {
                const typeName = sectionMatch[1].trim();
                // sectionMatch[2] 会在匹配到基类时捕获其名称, 否则为 undefined
                const baseName = sectionMatch[2] ? sectionMatch[2].trim() : null;

                currentSection = { base: baseName, contentLines: [] };
                preParsed.set(typeName, currentSection);
            } else if (currentSection) {
                currentSection.contentLines.push(trimmedLine);
            }
        }
        
        // --- 第二遍扫描：处理预解析的数据，填充正式的数据结构 ---
        // 优先处理 [Sections] 以便后续判断
        const sectionsData = preParsed.get('Sections');
        if (sectionsData) {
            for (const line of sectionsData.contentLines) {
                const [key, value] = this.parseKeyValue(line);
                if (key) {
                    // key 是类型(如AnimType), value 是注册表(如Animations)
                    if (value) this.sections.set(key, value);
                    // 同时记录这是一个复杂类型
                    this.complexTypes.add(key);
                }
            }
        }
        
        // 遍历所有解析出的节，填充 registries 和 schemas
        for (const [typeName, data] of preParsed.entries()) {
            // 创建或更新 schema 定义
            const definition = this.schemas.get(typeName) ?? { keys: new Map(), base: null };
            if (data.base) {
                definition.base = data.base;
            }
            
            // 根据节名处理内容
            if (typeName === 'Registries') {
                for (const line of data.contentLines) {
                    const [key, value] = this.parseKeyValue(line);
                    if (key && value) this.registries.set(key, value);
                }
            } else if (typeName === 'Sections') {
                // 已在上面优先处理, 此处跳过
                continue;
            } else { // 这是一个普通的类型定义节
                for (const line of data.contentLines) {
                    const [key, value] = this.parseKeyValue(line);
                    if (key) {
                        const keyName = key.split('(')[0].trim();
                        definition.keys.set(keyName, value || ''); // 确保值不是undefined
                    }
                }
            }
            this.schemas.set(typeName, definition);
        }

        if (this.registries.size > 0 || this.schemas.size > 0) {
            this.isLoaded = true;
        }
    }

    /**
     * 一个辅助函数，用于从一行文本中解析出键和值。
     * @param line 一行文本
     * @returns 一个包含 [key, value] 的元组
     */
    private parseKeyValue(line: string): [string | null, string | null] {
        const lineWithoutComment = line.split(';')[0];
        const equalsIndex = lineWithoutComment.indexOf('=');

        if (equalsIndex !== -1) {
            const key = lineWithoutComment.substring(0, equalsIndex).trim();
            const value = lineWithoutComment.substring(equalsIndex + 1).trim();
            return [key, value];
        } else {
            const key = lineWithoutComment.trim();
            return [key, null]; // 对于没有等号的行，值为 null
        }
    }

    /**
     * 根据注册表名获取其对应的类型名。
     * @param registryName 注册表名, 如 'BuildingTypes'
     * @returns 类型名, 如 'BuildingType', 或 undefined
     */
    public getTypeForRegistry(registryName: string): string | undefined {
        return this.registries.get(registryName);
    }
    
    /**
     * 根据类型名获取其对应的注册表名 (来自[Sections])。
     * @param typeName 类型名, 如 'AnimType'
     * @returns 注册表名, 如 'Animations', 或 undefined
     */
    public getRegistryForType(typeName: string): string | undefined {
        return this.sections.get(typeName);
    }

    /**
     * 获取所有在 [Registries] 中定义的注册表名称。
     * @returns 包含所有注册表名的 Set
     */
    public getRegistryNames(): Set<string> {
        return new Set(this.registries.keys());
    }

    /**
     * 获取那些映射到复杂对象类型（在[Sections]中定义）的注册表名称。
     * 这些是真正的“ID列表”注册表，应该被 `INIManager` 索引。
     * @returns 包含ID列表注册表名称的 Set
     */
    public getIdListRegistryNames(): Set<string> {
        const idListRegistries = new Set<string>();
        for (const [registryName, typeName] of this.registries.entries()) {
            if (this.complexTypes.has(typeName)) {
                idListRegistries.add(registryName);
            }
        }
        return idListRegistries;
    }

    /**
     * 获取指定类型的所有合法键，包括从所有父类递归继承的键。
     * @param typeName 类型名, 如 'BuildingType'
     * @returns 一个包含所有键及其值类型的 Map
     */
    public getAllKeysForType(typeName: string): Map<string, string> {
        // 优先从缓存中读取, 避免重复计算。
        if (this.keyCache.has(typeName)) {
            return this.keyCache.get(typeName)!;
        }

        const schema = this.schemas.get(typeName);
        if (!schema) {
            return new Map();
        }

        // 递归地获取父类的所有键。
        const baseKeys = schema.base ? this.getAllKeysForType(schema.base) : new Map();
        
        // 合并父类的键和当前类型的键。
        // Map的构造函数特性确保了子类键会覆盖父类的同名键。
        const allKeys = new Map([...baseKeys, ...schema.keys]);

        // 将计算结果存入缓存。
        this.keyCache.set(typeName, allKeys);
        return allKeys;
    }

    /**
     * 为指定类型生成一个详细的、用于调试的继承链分析报告。
     * @param typeName 要分析的类型名
     * @returns 一个字符串数组，每一行都是报告的一部分
     */
    public getDebugInfoForType(typeName: string): string[] {
        const lines: string[] = [];
        const analyzed = new Set<string>(); // 防止循环继承导致的无限递归

        const analyze = (name: string, indent: string) => {
            if (analyzed.has(name)) {
                lines.push(`${indent}- (错误: 在 '${name}' 处检测到循环继承)`);
                return;
            }
            analyzed.add(name);

            const definition = this.schemas.get(name);
            lines.push(`${indent}- 正在分析类型 '${name}'...`);

            if (!definition) {
                lines.push(`${indent}  - ❌ 错误: 在Schema中未找到此类型的定义。`);
                return;
            }

            lines.push(`${indent}  - 原生键数量: ${definition.keys.size}`);
            if (definition.base) {
                lines.push(`${indent}  - 继承自: '${definition.base}'`);
                analyze(definition.base, indent + "  ");
            } else {
                lines.push(`${indent}  - 已到达继承链顶端。`);
            }
        };

        analyze(typeName, "");
        return lines;
    }
}