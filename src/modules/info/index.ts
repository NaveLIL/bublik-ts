import { BublikModule } from '../../types';
import infoCommand from './commands/info';

const infoModule: BublikModule = {
  name: 'info',
  descriptionKey: 'modules.info.description',
  version: '1.0.0',
  author: 'NaveL',

  commands: [infoCommand],

  async onLoad(client) {
    client.logger.child('Module:info').info('Информационный модуль загружен');
  },

  async onUnload(client) {
    client.logger.child('Module:info').info('Информационный модуль выгружен');
  },
};

export default infoModule;
