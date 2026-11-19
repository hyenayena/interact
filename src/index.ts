import type {ModulePlugin} from '../../../src/api.js';
import {createCommand} from './commands.js';
import {postToChat} from './deps/chat.js';
import {registerRoute, webBaseUrl, webStatus} from './deps/web.js';
import {createGraphRoutes} from './graph/routes.js';
import {createGraphStore} from './graph/store.js';
import {noopLog} from './log.js';

let unregister: (() => void) | undefined;

const plugin: ModulePlugin = host => {
	const log = (host.log ?? noopLog).child('interact');
	const store = createGraphStore({dataDir: host.dataDir, log});
	const routes = createGraphRoutes({store, log, post: text => postToChat({owner: 'interact', text})});
	unregister?.();
	const offs = routes.map(registerRoute);
	unregister = () => offs.forEach(off => off());
	log.debug('plugin loaded', {routes: routes.length});
	return [createCommand({store, log, web: {baseUrl: webBaseUrl, status: webStatus}})];
};

export default plugin;
