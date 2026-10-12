import type { StorybookConfig } from "@storybook/html-vite";
export default {
  stories: ["../storybook/stories/*.stories.ts"],
  framework: "@storybook/html-vite",
  core: { disableTelemetry: true },
} satisfies StorybookConfig;
