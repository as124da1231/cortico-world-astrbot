/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { ASTRBOT } from './definition.ts';

export default ASTRBOT;
export { ASTRBOT };
export type { AstrbotConfigSection, AstrbotMode } from './config.ts';
