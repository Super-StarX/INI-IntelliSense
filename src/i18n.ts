import * as nls from 'vscode-nls';

// 在此模块中对 vscode-nls 进行一次性配置。
// 当首次调用 loadMessageBundle() 时，此配置将生效。
// 这使得我们可以在项目的任何地方导入并使用一个已配置好的 localize 函数。
nls.config({ messageFormat: nls.MessageFormat.file })();

/**
 * 导出一个本地化函数，供整个扩展项目使用。
 * 它会自动加载与当前 VS Code 显示语言匹配的语言包文件。
 * @example
 * localize('key.hello', 'Hello World!');
 * localize('key.greeting', 'Hello {0}!', 'John');
 */
export const localize = nls.loadMessageBundle();