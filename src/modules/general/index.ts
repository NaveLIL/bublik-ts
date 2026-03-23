import { BublikModule } from '../../types';
import pingCommand from './commands/ping';
import reloadCommand from './commands/reload';

const generalModule: BublikModule = {
  name: 'general',
  descriptionKey: 'modules.general.description',
  version: '1.0.0',
  author: 'NaveL',

  commands: [pingCommand, reloadCommand],

  async onLoad(client) {
    client.logger.child('Module:general').info('Общий модуль загружен');
  },

  async onUnload(client) {
    client.logger.child('Module:general').info('Общий модуль выгружен');
  },
};

export default generalModule;
