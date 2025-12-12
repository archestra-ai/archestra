/**
 * Parses Docker run arguments to extract the actual command and arguments
 * to run inside the container.
 *
 * The platform's K8s runtime creates native Kubernetes pods - it does NOT run
 * `docker run` commands. Instead, it uses the docker image directly in the pod spec.
 *
 * This parser transforms:
 * - External catalog: `command: "docker"`, `args: ["run", "-i", "--rm", "image:tag", "actual-cmd", "args"]`
 * - To internal format: `dockerImage: "image:tag"`, `command: "actual-cmd"`, `arguments: ["args"]`
 *
 * @param command - The command from external catalog (should be "docker")
 * @param args - Docker run arguments including image name and container command
 * @param dockerImage - The docker_image field from external catalog
 * @returns Parsed localConfig with command, arguments, and dockerImage, or null if not a Docker config
 *
 * @example
 * // Docker with custom command
 * parseDockerArgsToLocalConfig(
 *   "docker",
 *   ["run", "-i", "--rm", "pulumi/mcp-server:latest", "npx", "-y", "pulumi-mcp"],
 *   "pulumi/mcp-server:latest"
 * )
 * // Returns: { command: "npx", arguments: ["-y", "pulumi-mcp"], dockerImage: "pulumi/mcp-server:latest" }
 *
 * @example
 * // Docker with image default CMD
 * parseDockerArgsToLocalConfig(
 *   "docker",
 *   ["run", "-i", "--rm", "redis/mcp-redis:latest"],
 *   "redis/mcp-redis:latest"
 * )
 * // Returns: { dockerImage: "redis/mcp-redis:latest" }
 *
 * @example
 * // Docker with flags passed to image entrypoint (no command override)
 * parseDockerArgsToLocalConfig(
 *   "docker",
 *   ["run", "-i", "--rm", "mcp/grafana", "-t", "stdio"],
 *   "mcp/grafana"
 * )
 * // Returns: { arguments: ["-t", "stdio"], dockerImage: "mcp/grafana" }
 *
 * @example
 * // Non-Docker command
 * parseDockerArgsToLocalConfig("npx", ["-y", "@modelcontextprotocol/server"], undefined)
 * // Returns: null
 */
export function parseDockerArgsToLocalConfig(
  command: string,
  args: string[] | undefined,
  dockerImage: string | undefined,
): { command?: string; arguments?: string[]; dockerImage: string } | null {
  // If no docker_image provided, not a Docker config
  if (!dockerImage) return null;

  // If command is not "docker", not a Docker config
  if (command !== "docker") return null;

  if (!args || args.length === 0) {
    // No args - use image's default CMD
    return { dockerImage };
  }

  // Find the docker image in the args array
  const imageIndex = args.indexOf(dockerImage);

  if (imageIndex === -1) {
    // Image not found in args - might be using env vars or complex setup
    // Return just dockerImage, let container use its default CMD
    return { dockerImage };
  }

  // Everything after the image is the actual command and arguments to run in the container
  const commandAndArgs = args.slice(imageIndex + 1);

  if (commandAndArgs.length === 0) {
    // No command specified after image - use image's default CMD
    return { dockerImage };
  }

  // Check if first item is a flag (starts with -) or a command
  const firstItem = commandAndArgs[0];

  if (firstItem.startsWith("-")) {
    // First item is a flag, not a command - pass all items as args to image's entrypoint
    // Example: ["mcp/grafana", "-t", "stdio"] → command=undefined, arguments=["-t", "stdio"]
    return {
      arguments: commandAndArgs,
      dockerImage,
    };
  }

  // First item is the command, rest are arguments
  const [actualCommand, ...actualArguments] = commandAndArgs;

  return {
    command: actualCommand,
    arguments: actualArguments.length > 0 ? actualArguments : undefined,
    dockerImage,
  };
}
