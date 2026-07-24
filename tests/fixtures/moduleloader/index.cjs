const controls = globalThis.__bublikModuleLoaderFixture;
if (!controls) throw new Error('ModuleLoader fixture controls are not installed');

const generation = ++controls.imports;
const command = {
  data: { name: 'moduleloader-fixture-command' },
  scope: 'guild',
  generation,
  execute() {
    return controls.onCommand(generation);
  },
  autocomplete() {
    return controls.onAutocomplete(generation);
  },
};

const moduleDefinition = {
  name: 'moduleloader_fixture',
  descriptionKey: 'tests.moduleloader_fixture',
  version: String(generation),
  author: 'tests',
  commands: [command],
};

moduleDefinition.events = controls.guardedEvent
  ? [{
    event: 'moduleloaderFixtureEvent',
    executeGuarded(guard, value) {
      return controls.onEvent(generation, value, guard);
    },
  }]
  : [{
    event: 'moduleloaderFixtureEvent',
    execute(value) {
      return controls.onEvent(generation, value, undefined);
    },
  }];

if (controls.guardedOnLoad) {
  moduleDefinition.onLoadGuarded = (client, guard) => (
    controls.onLoad(generation, client, guard)
  );
} else {
  moduleDefinition.onLoad = (client) => controls.onLoad(generation, client, undefined);
}

if (controls.bothOnLoad) {
  moduleDefinition.onLoad = (client) => controls.onLoad(generation, client, undefined);
  moduleDefinition.onLoadGuarded = (client, guard) => (
    controls.onLoad(generation, client, guard)
  );
}

if (controls.guardedOnUnload) {
  moduleDefinition.onUnloadGuarded = (client, guard) => (
    controls.onUnload(generation, client, guard)
  );
} else {
  moduleDefinition.onUnload = (client) => controls.onUnload(generation, client, undefined);
}

module.exports = moduleDefinition;
