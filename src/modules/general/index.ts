import { BublikModule } from '../../types';
import pingCommand from './commands/ping';
import reloadCommand from './commands/reload';
import languageCommand from './commands/language';
import helpCommand from './commands/help';
import setupCommand from './commands/setup';
import whitelistCommand from './commands/whitelist';

const generalModule: BublikModule = {
  name: 'general',
  descriptionKey: 'modules.general.description',
  version: '1.0.0',
  author: 'NaveLIL',

  commands: [pingCommand, reloadCommand, languageCommand, helpCommand, setupCommand, whitelistCommand],

  async onLoad(client) {
    client.logger.child('Module:general').info('Общий модуль загружен');
  },

  async onUnload(client) {
    client.logger.child('Module:general').info('Общий модуль выгружен');
  },
};

export default generalModule;
