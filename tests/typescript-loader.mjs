import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
        const absolute = path.join(repositoryRoot, specifier.slice(2));
        return nextResolve(pathToFileURL(`${absolute}.ts`).href, context);
    }

    try {
        return await nextResolve(specifier, context);
    } catch (error) {
        const isRelativeTypeScriptImport = (specifier.startsWith("./") || specifier.startsWith("../"))
            && path.extname(specifier) === "";
        if (!isRelativeTypeScriptImport || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
        return nextResolve(`${specifier}.ts`, context);
    }
}

export async function load(url, context, nextLoad) {
    if (!url.endsWith(".ts") && !url.endsWith(".tsx")) return nextLoad(url, context);
    const source = await readFile(fileURLToPath(url), "utf8");
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: fileURLToPath(url),
    });
    return { format: "module", shortCircuit: true, source: transpiled.outputText };
}
