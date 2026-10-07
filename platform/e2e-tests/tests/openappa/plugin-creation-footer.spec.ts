import { defineResourceCreationFooterTests } from "../resource-creation-footer";

// Plugins follow ARCHESTRA_BETA, so they run on the beta stack.
defineResourceCreationFooterTests(["plugins"]);
