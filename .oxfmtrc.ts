import { defineConfig } from "oxfmt";

export default defineConfig({
    useTabs: false,
    tabWidth: 4,
    printWidth: 120,
    singleQuote: false,
    jsxSingleQuote: false,
    quoteProps: "as-needed",
    trailingComma: "all",
    semi: true,
    arrowParens: "always",
    bracketSameLine: false,
    bracketSpacing: true,
    sortImports: {
        groups: [
            "type-import",
            ["value-builtin", "value-external"],
            ["value-parent", "value-sibling", "value-index"],
            "unknown",
        ],
        newlinesBetween: false,
    },
});
