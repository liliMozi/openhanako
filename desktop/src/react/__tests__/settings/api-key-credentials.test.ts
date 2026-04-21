import { describe, expect, it } from 'vitest';
import { getApiKeySavePlan } from '../../settings/tabs/providers/api-key-save-plan';

describe('getApiKeySavePlan', () => {
  it('allows clearing an edited api key without forcing remote verification', () => {
    expect(getApiKeySavePlan({
      keyEdited: true,
      keyVal: '',
      urlEdited: false,
      urlVal: 'https://api.example.com/v1',
      derivedBaseUrl: 'https://api.example.com/v1',
      isPresetSetup: false,
      isLocalPreset: false,
      api: 'openai-completions',
    })).toEqual({
      shouldSave: true,
      shouldVerify: false,
      payload: { api_key: '' },
      effectiveUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      key: '',
    });
  });
});
