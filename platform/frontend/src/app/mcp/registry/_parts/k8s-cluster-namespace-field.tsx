"use client";

import { useEffect } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useK8sClusters,
  useK8sNamespaces,
} from "@/lib/k8s/k8s-cluster.query";

const DEFAULT_CLUSTER_ID = "__default__";

interface K8sClusterNamespaceFieldProps {
  clusterId: string | null;
  namespace: string;
  onClusterChange: (clusterId: string | null) => void;
  onNamespaceChange: (namespace: string) => void;
  disabled?: boolean;
}

export function K8sClusterNamespaceField({
  clusterId,
  namespace,
  onClusterChange,
  onNamespaceChange,
  disabled,
}: K8sClusterNamespaceFieldProps) {
  const { data: clustersData } = useK8sClusters();
  const clusters = clustersData?.clusters ?? [];

  const { data: namespacesData } = useK8sNamespaces(clusterId);
  const namespaces = namespacesData?.namespaces ?? [];
  const defaultNamespace = namespacesData?.defaultNamespace ?? "default";

  // Reset namespace to default when cluster changes
  useEffect(() => {
    if (namespaces.length > 0 && !namespaces.includes(namespace)) {
      onNamespaceChange(defaultNamespace);
    }
  }, [clusterId, namespaces, defaultNamespace, namespace, onNamespaceChange]);

  const selectedClusterValue = clusterId ?? DEFAULT_CLUSTER_ID;

  const handleClusterChange = (value: string) => {
    onClusterChange(value === DEFAULT_CLUSTER_ID ? null : value);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>Kubernetes Cluster</Label>
        <Select
          value={selectedClusterValue}
          onValueChange={handleClusterChange}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select cluster" />
          </SelectTrigger>
          <SelectContent>
            {clusters.map((cluster) => (
              <SelectItem
                key={cluster.id ?? DEFAULT_CLUSTER_ID}
                value={cluster.id ?? DEFAULT_CLUSTER_ID}
              >
                {cluster.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Kubernetes Namespace</Label>
        <Select
          value={namespace || defaultNamespace}
          onValueChange={onNamespaceChange}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select namespace" />
          </SelectTrigger>
          <SelectContent>
            {namespaces.map((ns) => (
              <SelectItem key={ns} value={ns}>
                {ns}
              </SelectItem>
            ))}
            {/* Always include the current value even if not in list */}
            {namespace && !namespaces.includes(namespace) && (
              <SelectItem value={namespace}>{namespace}</SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
