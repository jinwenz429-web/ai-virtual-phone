import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./typescript-loader.mjs", pathToFileURL(`${process.cwd()}/tests/`));
