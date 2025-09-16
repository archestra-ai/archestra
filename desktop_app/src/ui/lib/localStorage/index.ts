import { DEFAULT_SYSTEM_PROMPT } from '../../../constants';

class BaseLocalStorage {
  static keyPrefix: string = '';

  static _constructKey(key: string) {
    return `archestra-app:${this.keyPrefix}:${key}`;
  }

  static get(key: string) {
    return localStorage.getItem(this._constructKey(key));
  }

  static set(key: string, value: string) {
    localStorage.setItem(this._constructKey(key), value);
  }
}

export class OllamaLocalStorage extends BaseLocalStorage {
  static keyPrefix = 'ollama';

  static getSelectedModel() {
    return super.get('selectedModel');
  }

  static setSelectedModel(model: string) {
    super.set('selectedModel', model);
  }
}

export class SettingsLocalStorage extends BaseLocalStorage {
  static keyPrefix = 'settings';

  static getSystemPrompt() {
    return super.get('systemPrompt') || DEFAULT_SYSTEM_PROMPT;
  }

  static setSystemPrompt(prompt: string) {
    super.set('systemPrompt', prompt);
  }
}
