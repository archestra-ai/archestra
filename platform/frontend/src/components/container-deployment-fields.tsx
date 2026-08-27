"use client";

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface ContainerDeploymentValue {
  image: string;
  command: string;
  arguments: string;
}

export function ContainerDeploymentFields({
  ids,
  value,
  onChange,
  image,
  command,
  arguments: argumentsOptions,
  errors,
  autoComplete,
}: {
  ids: {
    image: string;
    command: string;
    arguments: string;
  };
  value: ContainerDeploymentValue;
  onChange: (value: ContainerDeploymentValue) => void;
  image?: ContainerFieldOptions & { optional?: boolean };
  command?: ContainerFieldOptions;
  arguments?: Omit<ContainerFieldOptions, "description">;
  errors?: Partial<Record<keyof ContainerDeploymentValue, ReactNode>>;
  autoComplete?: string;
}) {
  return (
    <div className="space-y-4">
      <ContainerImageField
        id={ids.image}
        value={value.image}
        onChange={(nextImage) => onChange({ ...value, image: nextImage })}
        placeholder={image?.placeholder}
        optional={image?.optional}
        labelAddon={image?.labelAddon}
        description={image?.description}
        error={errors?.image}
        autoComplete={autoComplete}
      />
      <ContainerCommandField
        id={ids.command}
        value={value.command}
        onChange={(nextCommand) => onChange({ ...value, command: nextCommand })}
        placeholder={command?.placeholder}
        labelAddon={command?.labelAddon}
        description={command?.description}
        error={errors?.command}
        autoComplete={autoComplete}
      />
      <ContainerArgumentsField
        id={ids.arguments}
        value={value.arguments}
        onChange={(nextArguments) =>
          onChange({ ...value, arguments: nextArguments })
        }
        placeholder={argumentsOptions?.placeholder}
        labelAddon={argumentsOptions?.labelAddon}
        error={errors?.arguments}
        autoComplete={autoComplete}
      />
    </div>
  );
}

interface ContainerFieldOptions {
  placeholder?: string;
  labelAddon?: ReactNode;
  description?: ReactNode;
}

interface ContainerFieldProps extends ContainerFieldOptions {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: ReactNode;
  autoComplete?: string;
}

function ContainerImageField({
  id,
  value,
  onChange,
  placeholder,
  optional = false,
  labelAddon,
  description,
  error,
  autoComplete,
}: ContainerFieldProps & { optional?: boolean }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        <span>Container image</span>
        {optional && <span> (optional)</span>}
        {labelAddon}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="font-mono"
        autoComplete={autoComplete}
      />
      <FieldDescription description={description} error={error} />
    </div>
  );
}

function ContainerCommandField({
  id,
  value,
  onChange,
  placeholder,
  labelAddon,
  description,
  error,
  autoComplete,
}: ContainerFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Command{labelAddon}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="font-mono"
        autoComplete={autoComplete}
      />
      <FieldDescription description={description} error={error} />
    </div>
  );
}

function ContainerArgumentsField({
  id,
  value,
  onChange,
  placeholder,
  labelAddon,
  error,
  autoComplete,
}: Omit<ContainerFieldProps, "description">) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Arguments (one per line){labelAddon}</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-20 font-mono"
        autoComplete={autoComplete}
      />
      <FieldDescription error={error} />
    </div>
  );
}

function FieldDescription({
  description,
  error,
}: {
  description?: ReactNode;
  error?: ReactNode;
}) {
  return (
    <>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {error && <p className="text-sm font-medium text-destructive">{error}</p>}
    </>
  );
}
