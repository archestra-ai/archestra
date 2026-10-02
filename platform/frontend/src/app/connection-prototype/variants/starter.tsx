"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PrototypeVariantProps } from "../variants";

const PREVIEW_LIMIT = 8;

// Copy this file to start a new variant. It renders every part of the mock
// scenario so it is obvious what data is available to design with.
export default function StarterVariant({
  scenario,
  persona,
}: PrototypeVariantProps) {
  const toolCount = scenario.servers.reduce(
    (total, server) => total + server.toolCount,
    0,
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">
          Hi {scenario.userName}, connect your agent
        </h1>
        <p className="text-muted-foreground">
          {scenario.servers.length} servers · {toolCount} tools ·{" "}
          {scenario.skills.length} skills · viewing as {persona}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Servers</CardTitle>
          <CardDescription>scenario.servers</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {scenario.servers.slice(0, PREVIEW_LIMIT).map((server) => (
            <div key={server.id} className="flex items-center gap-2 text-sm">
              <span className="font-medium">{server.name}</span>
              <span className="text-muted-foreground">
                {server.toolCount} tools
              </span>
              {server.authenticated ? null : (
                <Badge variant="outline">Sign-in needed</Badge>
              )}
              {server.exampleAsk ? (
                <span className="ml-auto text-muted-foreground italic">
                  “{server.exampleAsk}”
                </span>
              ) : null}
            </div>
          ))}
          {scenario.servers.length > PREVIEW_LIMIT ? (
            <p className="text-sm text-muted-foreground">
              and {scenario.servers.length - PREVIEW_LIMIT} more
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Skills</CardTitle>
          <CardDescription>scenario.skills</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {scenario.skills.slice(0, PREVIEW_LIMIT).map((skill) => (
            <div key={skill.id} className="text-sm">
              <span className="font-medium">{skill.name}</span>
              <span className="text-muted-foreground">
                {" "}
                · {skill.description}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected agents</CardTitle>
          <CardDescription>scenario.connectedAgents</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {scenario.connectedAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            scenario.connectedAgents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 text-sm">
                <span className="font-medium">{agent.clientLabel}</span>
                <Badge variant="secondary">{agent.status}</Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {persona === "admin" ? (
        <Card>
          <CardHeader>
            <CardTitle>Adoption</CardTitle>
            <CardDescription>scenario.adoption</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {scenario.adoption.connectedUsers} of {scenario.adoption.totalUsers}{" "}
            users connected, {scenario.adoption.activeThisWeek} active this week
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
