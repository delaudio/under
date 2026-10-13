import type { Meta, StoryObj } from "@storybook/html";
import { terminalPreview } from "../preview";
const meta = {
  title: "Under/Workspace",
  parameters: { layout: "centered" },
} satisfies Meta;
export default meta;
export const Wide = {
  render: () => terminalPreview("wide"),
} satisfies StoryObj;
export const Medium = {
  render: () => terminalPreview("medium"),
} satisfies StoryObj;
export const Narrow = {
  render: () => terminalPreview("narrow"),
} satisfies StoryObj;
export const Tiny = {
  render: () => terminalPreview("tiny"),
} satisfies StoryObj;
export const Files = {
  render: () => terminalPreview("files"),
} satisfies StoryObj;
export const Navigation = {
  render: () => terminalPreview("navigation"),
} satisfies StoryObj;
export const FilesNarrow = {
  render: () => terminalPreview("files-narrow"),
} satisfies StoryObj;
export const Empty = {
  render: () => terminalPreview("empty"),
} satisfies StoryObj;
export const Restore = {
  render: () => terminalPreview("restore"),
} satisfies StoryObj;
export const FileMenu = {
  render: () => terminalPreview("file-menu"),
} satisfies StoryObj;
export const ViewMenu = {
  render: () => terminalPreview("view-menu"),
} satisfies StoryObj;
export const ToolsMenu = {
  render: () => terminalPreview("tools-menu"),
} satisfies StoryObj;
export const AgentMenu = {
  render: () => terminalPreview("agent-menu"),
} satisfies StoryObj;
export const HelpMenu = {
  render: () => terminalPreview("help-menu"),
} satisfies StoryObj;
export const WrappedMenu = {
  render: () => terminalPreview("wrapped-menu"),
} satisfies StoryObj;
export const ScrolledMenu = {
  render: () => terminalPreview("scrolled-menu"),
} satisfies StoryObj;
export const Palette = {
  render: () => terminalPreview("palette"),
} satisfies StoryObj;
export const Help = {
  render: () => terminalPreview("help"),
} satisfies StoryObj;
export const HelpTiny = {
  render: () => terminalPreview("help-tiny"),
} satisfies StoryObj;
export const OpenFile = {
  render: () => terminalPreview("open-file"),
} satisfies StoryObj;
export const Error = {
  render: () => terminalPreview("error"),
} satisfies StoryObj;
export const ChatCodex = {
  render: () => terminalPreview("chat-codex"),
} satisfies StoryObj;
export const ChatClaude = {
  render: () => terminalPreview("chat-claude"),
} satisfies StoryObj;
export const ChatOpencode = {
  render: () => terminalPreview("chat-opencode"),
} satisfies StoryObj;
export const ChatExited = {
  render: () => terminalPreview("chat-exited"),
} satisfies StoryObj;
export const ChatStopping = {
  render: () => terminalPreview("chat-stopping"),
} satisfies StoryObj;
export const ChatError = {
  render: () => terminalPreview("chat-error"),
} satisfies StoryObj;
export const HiddenFiles = {
  render: () => terminalPreview("hidden-files"),
} satisfies StoryObj;
export const DisabledAgent = {
  render: () => terminalPreview("disabled-agent"),
} satisfies StoryObj;
export const Context = {
  render: () => terminalPreview("context"),
} satisfies StoryObj;

export const NativeFiles = {
  render: () => terminalPreview("native-files"),
} satisfies StoryObj;
export const ReviewMenu = {
  render: () => terminalPreview("review-menu"),
} satisfies StoryObj;

export const ResizeDrag = {
  render: () => terminalPreview("resize-drag"),
} satisfies StoryObj;

export const TemplateChat = {
  render: () => terminalPreview("tpl-chat"),
} satisfies StoryObj;

export const TemplateFilesEditor = {
  render: () => terminalPreview("tpl-files-editor"),
} satisfies StoryObj;

export const TemplateReview = {
  render: () => terminalPreview("tpl-review"),
} satisfies StoryObj;

export const TemplateFilesReview = {
  render: () => terminalPreview("tpl-files-review"),
} satisfies StoryObj;

export const TemplateEditorChat = {
  render: () => terminalPreview("tpl-editor-chat"),
} satisfies StoryObj;

export const TemplateEditor = {
  render: () => terminalPreview("tpl-editor"),
} satisfies StoryObj;

export const TemplateRun = {
  render: () => terminalPreview("tpl-run"),
} satisfies StoryObj;

export const TemplateEditorChatStack = {
  render: () => terminalPreview("tpl-editor-chat-stack"),
} satisfies StoryObj;

export const TemplateCompose = {
  render: () => terminalPreview("tpl-compose"),
} satisfies StoryObj;

export const ReviewScoped = {
  render: () => terminalPreview("review-scoped"),
} satisfies StoryObj;
