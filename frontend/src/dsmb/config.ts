export function dsmbExtensionsEnabled(): boolean {
    const raw = process.env.NEXT_PUBLIC_MIKE_EXTENSIONS ?? "";
    return raw
        .split(",")
        .map((s) => s.trim())
        .includes("litigation");
}
