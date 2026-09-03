import { defineConfig, presetWind3 } from 'unocss';
import transformerDirectives from '@unocss/transformer-directives';

export default defineConfig({
  presets: [presetWind3({ preflight: false })],
  transformers: [transformerDirectives()],
});
