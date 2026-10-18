'use strict';

// mqtt-mini – kleiner MQTT-3.1.1-Client ohne Abhängigkeiten für die eigenen Homebridge-Plugins.
// Kann: verbinden mit Benutzer/Passwort, abonnieren (QoS 1), senden (QoS 0/1, retain), Ping, Neuverbindung.
// Kann nicht: TLS, Last Will, erneutes Senden unbestätigter Nachrichten (geht bei Verbindungsabbruch verloren).
// Schema und Broker: twh-infra konzepte/mqtt.md

const net = require('net');
const fs = require('fs');
const { EventEmitter } = require('events');

function str(s) {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
}

function laenge(n) {                     // „Remaining Length“ als variable Länge
  const bytes = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

function paket(kopf, rumpf) {
  return Buffer.concat([Buffer.from([kopf]), laenge(rumpf.length), rumpf]);
}

// Liest MQTT_HOST, MQTT_USER, MQTT_PASS aus einer .env-Datei (/etc/twh-mqtt/<benutzer>.env)
function zugangLesen(pfad) {
  const z = {};
  for (const zeile of fs.readFileSync(pfad, 'utf8').split('\n')) {
    const m = zeile.match(/^\s*([A-Z_]+)=(.*)$/);
    if (m) z[m[1]] = m[2].trim();
  }
  return { host: z.MQTT_HOST || 'localhost', user: z.MQTT_USER, pass: z.MQTT_PASS };
}

class MqttMini extends EventEmitter {
  constructor({ host, port = 1883, user, pass, clientId, keepalive = 30 }) {
    super();
    Object.assign(this, { host, port, user, pass, clientId, keepalive });
    this.abos = new Set();
    this.verbunden = false;
    this.paketId = 0;
    this.puffer = Buffer.alloc(0);
    this.warten = 1000;
    this.ende = false;
    this._verbinden();
  }

  _id() {
    this.paketId = (this.paketId % 65535) + 1;
    return this.paketId;
  }

  _verbinden() {
    if (this.ende) return;
    this.puffer = Buffer.alloc(0);
    const s = this.socket = net.createConnection({ host: this.host, port: this.port });
    s.setNoDelay(true);
    s.on('connect', () => {
      let flags = 0x02;                                          // clean session
      if (this.user) flags |= 0x80;
      if (this.pass) flags |= 0x40;
      const ka = Buffer.alloc(2); ka.writeUInt16BE(this.keepalive);
      const teile = [str('MQTT'), Buffer.from([4, flags]), ka, str(this.clientId)];
      if (this.user) teile.push(str(this.user));
      if (this.pass) teile.push(str(this.pass));
      s.write(paket(0x10, Buffer.concat(teile)));
    });
    s.on('data', (d) => this._daten(d));
    s.on('error', (e) => this.emit('fehler', e));
    s.on('close', () => {
      const war = this.verbunden;
      this.verbunden = false;
      clearInterval(this.pingTimer);
      if (war) this.emit('getrennt');
      if (!this.ende) {
        setTimeout(() => this._verbinden(), this.warten);
        this.warten = Math.min(this.warten * 2, 30000);
      }
    });
  }

  _daten(d) {
    this.puffer = Buffer.concat([this.puffer, d]);
    for (;;) {
      if (this.puffer.length < 2) return;
      let mult = 1, rest = 0, i = 1, b;
      do {
        if (i >= this.puffer.length) return;                     // Länge noch unvollständig
        b = this.puffer[i++];
        rest += (b & 0x7f) * mult;
        mult *= 128;
      } while (b & 0x80);
      if (this.puffer.length < i + rest) return;
      const kopf = this.puffer[0];
      const rumpf = this.puffer.subarray(i, i + rest);
      this.puffer = this.puffer.subarray(i + rest);
      this._paket(kopf, rumpf);
    }
  }

  _paket(kopf, rumpf) {
    const typ = kopf >> 4;
    if (typ === 2) {                                             // CONNACK
      if (rumpf[1] !== 0) {
        this.emit('fehler', new Error(`Broker lehnt ab (Code ${rumpf[1]})`));
        this.socket.destroy();
        return;
      }
      this.verbunden = true;
      this.warten = 1000;
      this.letzteAntwort = Date.now();
      this.pingTimer = setInterval(() => this._ping(), (this.keepalive * 1000) / 2);
      for (const t of this.abos) this._abonnieren(t);
      this.emit('verbunden');
    } else if (typ === 3) {                                      // PUBLISH
      const qos = (kopf >> 1) & 3;
      const retain = (kopf & 1) === 1;
      const tl = rumpf.readUInt16BE(0);
      const topic = rumpf.subarray(2, 2 + tl).toString('utf8');
      let pos = 2 + tl;
      if (qos > 0) {
        const id = rumpf.readUInt16BE(pos);
        pos += 2;
        const ack = Buffer.alloc(2); ack.writeUInt16BE(id);
        this.socket.write(paket(0x40, ack));                     // PUBACK
      }
      this.emit('nachricht', topic, rumpf.subarray(pos).toString('utf8'), retain);
    } else if (typ === 13) {                                     // PINGRESP
      this.letzteAntwort = Date.now();
    }
    // SUBACK (9) und PUBACK (4) brauchen wir nicht auszuwerten
  }

  _ping() {
    if (Date.now() - this.letzteAntwort > this.keepalive * 1500) {
      this.emit('fehler', new Error('keine Antwort vom Broker'));
      this.socket.destroy();
      return;
    }
    this.socket.write(Buffer.from([0xc0, 0]));                   // PINGREQ
  }

  _abonnieren(topic) {
    const id = Buffer.alloc(2); id.writeUInt16BE(this._id());
    this.socket.write(paket(0x82, Buffer.concat([id, str(topic), Buffer.from([1])])));
  }

  abonnieren(topic) {
    this.abos.add(topic);
    if (this.verbunden) this._abonnieren(topic);
  }

  senden(topic, wert, { qos = 1, retain = false } = {}) {
    if (!this.verbunden) return false;
    const teile = [str(topic)];
    if (qos > 0) {
      const id = Buffer.alloc(2); id.writeUInt16BE(this._id());
      teile.push(id);
    }
    teile.push(Buffer.from(String(wert), 'utf8'));
    this.socket.write(paket(0x30 | (qos << 1) | (retain ? 1 : 0), Buffer.concat(teile)));
    return true;
  }

  beenden() {
    this.ende = true;
    clearInterval(this.pingTimer);
    if (this.socket) {
      if (this.verbunden) this.socket.write(Buffer.from([0xe0, 0]));   // DISCONNECT
      this.socket.end();
    }
  }
}

module.exports = { MqttMini, zugangLesen };
