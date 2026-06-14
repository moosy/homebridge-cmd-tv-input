'use strict';

const { exec } = require('child_process');

const PLUGIN_NAME   = 'homebridge-cmd-television';
const PLATFORM_NAME = 'CmdTelevision';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, CmdTelevisionPlatform);
};

class CmdTelevisionPlatform {
  constructor(log, config, api) {
    this.log    = log;
    this.config = config;
    this.api    = api;
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory) {}

  discoverDevices() {
    const televisions = this.config.televisions || [];
    for (const tvConfig of televisions) {
      if (!tvConfig.name || !tvConfig.inputs || !tvConfig.state_cmd) {
        this.log.error('CmdTelevision: name, inputs and state_cmd are required.');
        continue;
      }
      const uuid      = this.api.hap.uuid.generate(PLUGIN_NAME + ':' + tvConfig.name);
      const accessory = new this.api.platformAccessory(
        tvConfig.name,
        uuid,
        this.api.hap.Categories.TELEVISION,
      );
      new CmdTelevisionAccessory(this, accessory, tvConfig);
      this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      this.log.info(`CmdTelevision: published "${tvConfig.name}"`);
    }
  }
}

class CmdTelevisionAccessory {
  constructor(platform, accessory, config) {
    this.platform       = platform;
    this.accessory      = accessory;
    this.config         = config;
    this.log            = platform.log;
    this.hap            = platform.api.hap;
    this.Characteristic = this.hap.Characteristic;
    this.Service        = this.hap.Service;
    this.activeIdentifier = 0;
    this.isActive         = false;

    // ── AccessoryInformation ────────────────────────────────────────────────
    this.accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, 'moosy')
      .setCharacteristic(this.Characteristic.Model,        'CmdTelevision')
      .setCharacteristic(this.Characteristic.SerialNumber, accessory.UUID);

    // ── Television Service ──────────────────────────────────────────────────
    this.tvService =
      this.accessory.getService(this.Service.Television) ||
      this.accessory.addService(this.Service.Television);

    this.tvService
      .setCharacteristic(this.Characteristic.ConfiguredName, config.name)
      .setCharacteristic(this.Characteristic.SleepDiscoveryMode,
        this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    // ── Active — echtes Ein/Aus ─────────────────────────────────────────────
    this.tvService.getCharacteristic(this.Characteristic.Active)
      .onGet(() => this.isActive
        ? this.Characteristic.Active.ACTIVE
        : this.Characteristic.Active.INACTIVE)
      .onSet(async (value) => {
        if (value === this.Characteristic.Active.ACTIVE) {
          if (config.on_cmd) {
            this.log.info(`CmdTelevision: EIN → ${config.on_cmd}`);
            try {
              const output = (await this.runCmd(config.on_cmd)).trim();
              // on_cmd gibt den aktiven Input-Namen zurück
              const idx = config.inputs.findIndex(inp => inp.name === output);
              if (idx >= 0) {
                this.activeIdentifier = idx + 1;
                this.tvService.updateCharacteristic(
                  this.Characteristic.ActiveIdentifier, this.activeIdentifier);
              }
            } catch (e) {
              this.log.error(`CmdTelevision: on_cmd fehlgeschlagen: ${e}`);
            }
          }
          this.isActive = true;
        } else {
          if (config.off_cmd) {
            this.log.info(`CmdTelevision: AUS → ${config.off_cmd}`);
            try {
              await this.runCmd(config.off_cmd);
            } catch (e) {
              this.log.error(`CmdTelevision: off_cmd fehlgeschlagen: ${e}`);
            }
          }
          this.isActive = false;
        }
      });

    // ── ActiveIdentifier ────────────────────────────────────────────────────
    this.tvService.getCharacteristic(this.Characteristic.ActiveIdentifier)
      .onGet(() => this.activeIdentifier)
      .onSet(async (value) => {
        await this.activateInput(value);
      });

    // ── InputSource Services ────────────────────────────────────────────────
    for (let i = 0; i < config.inputs.length; i++) {
      const input       = config.inputs[i];
      const identifier  = i + 1;
      const svcId       = `input-${identifier}`;
      const displayName = input.label ?? input.name;  // label für HomeKit, name intern

      const inputSvc =
        this.accessory.getServiceById(this.Service.InputSource, svcId) ||
        this.accessory.addService(this.Service.InputSource, displayName, svcId);

      inputSvc
        .setCharacteristic(this.Characteristic.Identifier,            identifier)
        .setCharacteristic(this.Characteristic.ConfiguredName,        displayName)
        .setCharacteristic(this.Characteristic.IsConfigured,
          this.Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(this.Characteristic.InputSourceType,
          this.Characteristic.InputSourceType.OTHER)
        .setCharacteristic(this.Characteristic.CurrentVisibilityState,
          this.Characteristic.CurrentVisibilityState.SHOWN);

      this.tvService.addLinkedService(inputSvc);
    }

    // ── Polling ─────────────────────────────────────────────────────────────
    const interval = (config.polling_interval ?? 10) * 1000;
    this.pollState();
    setInterval(() => this.pollState(), interval);
  }

  async activateInput(id) {
    const input = this.config.inputs[id - 1];
    if (!input) {
      this.log.warn(`CmdTelevision: unknown identifier ${id}`);
      return;
    }
    // cmd optional — Fallback: set_cmd + name (kein Leerzeichen-Problem da name intern)
    const cmd = input.cmd ?? `${this.config.set_cmd} ${input.name}`;
    this.log.info(`CmdTelevision: Input "${input.label ?? input.name}" → ${cmd}`);
    try {
      await this.runCmd(cmd);
      this.activeIdentifier = id;
      this.isActive         = true;
      this.tvService.updateCharacteristic(
        this.Characteristic.Active,
        this.Characteristic.Active.ACTIVE);
      this.tvService.updateCharacteristic(
        this.Characteristic.ActiveIdentifier, id);
    } catch (e) {
      this.log.error(`CmdTelevision: activateInput fehlgeschlagen: ${e}`);
    }
  }

  async pollState() {
    try {
      const output = (await this.runCmd(this.config.state_cmd)).trim();
      // Vergleich gegen name (interner Schlüssel, kein Leerzeichen)
      const idx    = this.config.inputs.findIndex(inp => inp.name === output);
      const newId  = idx >= 0 ? idx + 1 : 0;
      const active = newId > 0;

      if (active !== this.isActive) {
        this.isActive = active;
        this.tvService.updateCharacteristic(
          this.Characteristic.Active,
          active
            ? this.Characteristic.Active.ACTIVE
            : this.Characteristic.Active.INACTIVE,
        );
      }
      if (newId !== this.activeIdentifier && newId > 0) {
        this.activeIdentifier = newId;
        this.tvService.updateCharacteristic(
          this.Characteristic.ActiveIdentifier, newId);
      }
    } catch (e) {
      this.log.debug(`CmdTelevision: poll failed: ${e}`);
    }
  }

  runCmd(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: this.config.timeout ?? 3000 }, (error, stdout, stderr) => {
        if (error) reject(stderr || error.message);
        else       resolve(stdout);
      });
    });
  }
}
