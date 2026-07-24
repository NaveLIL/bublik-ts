import { BublikModule } from '../../types';
import mcCommand from './commands/mc';
import { startMinecraftStatusTracker, stopMinecraftStatusTracker } from './services/status-tracker';

const minecraftModule: BublikModule = {
  name: 'minecraft',
  descriptionKey: 'modules.minecraft.description',
  version: '1.0.0',
  author: 'NaveL',

  commands: [mcCommand],

  async onLoad(client) {
    client.logger.child('Module:minecraft').info('Модуль Minecraft (EREZCRAFT) загружен');
    await startMinecraftStatusTracker(client);
  },

  async onUnload(client) {
    client.logger.child('Module:minecraft').info('Модуль Minecraft (EREZCRAFT) выгружен');
    stopMinecraftStatusTracker();
  },
};

export default minecraftModule;
