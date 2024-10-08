import { setup, Preview } from "@storybook/vue3";
import { Quasar, Dialog, Loading, Notify } from "quasar";
import iconSet from "quasar/icon-set/material-icons";
import { withThemeByDataAttribute } from "@storybook/addon-themes";
import { addActionsWithEmits } from "./utils/argTypesEnhancers";
import { markdownItPlugin } from "@/plugins/markdownItPlugin";

import "@quasar/extras/material-icons/material-icons.css";
import "quasar/dist/quasar.sass";
import "../src/styles/_index.scss";

setup((app) => {
  app.use(Quasar, {
    config: {
      brand: {
        primary: "#a5d4ad",
        secondary: "#212121",
        negative: "var(--color-warning)",
      },
    },
    iconSet,
    plugins: {
      Dialog,
      Loading,
      Notify,
    },
  });
  app.use(markdownItPlugin);
});

const preview: Preview = {
  tags: ["autodocs"],
  parameters: {
    docs: {
      toc: true,
    },
    backgrounds: {
      default: "theme",
      values: [
        {
          name: "theme",
          value: "var(--color-v2-background)",
        },
        {
          name: "light",
          value: "#fff",
        },
        {
          name: "dark",
          value: "#333",
        },
      ],
    },
  },
  decorators: [
    withThemeByDataAttribute({
      themes: {
        light: "false",
        dark: "true",
      },
      defaultTheme: "light",
      attributeName: "is-dark-theme",
    }),
  ],
  argTypesEnhancers: [addActionsWithEmits],
};

export default preview;
