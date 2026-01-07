"use client";

import {
  type archestraApiTypes,
  providerDisplayNames,
  type SupportedProvider,
  SupportedProviders,
} from "@shared";
import { Edit, Plus, Save, Settings, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PermissionButton } from "@/components/ui/permission-button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type ChatModel, useChatModelsQuery } from "@/lib/chat-models.query";
import {
  useCreateTokenPrice,
  useDeleteTokenPrice,
  useTokenPrices,
  useUpdateTokenPrice,
} from "@/lib/token-price.query";

// Type aliases for better readability
type TokenPriceData = archestraApiTypes.GetTokenPricesResponses["200"][number];

// Loading skeleton component
function LoadingSkeleton({ count, prefix }: { count: number; prefix: string }) {
  const skeletons = Array.from(
    { length: count },
    (_, i) => `${prefix}-skeleton-${i}`,
  );

  return (
    <div className="space-y-3">
      {skeletons.map((key) => (
        <div key={key} className="h-16 bg-muted animate-pulse rounded" />
      ))}
    </div>
  );
}

// Inline Form Component for adding/editing token prices
function TokenPriceInlineForm({
  initialData,
  onSave,
  onCancel,
  models = [],
}: {
  initialData?: TokenPriceData;
  onSave: (data: archestraApiTypes.CreateTokenPriceData["body"]) => void;
  onCancel: () => void;
  models?: ChatModel[];
}) {
  const [formData, setFormData] = useState({
    provider: initialData?.provider || ("openai" as const),
    model: initialData?.model || "",
    pricePerMillionInput: String(initialData?.pricePerMillionInput || ""),
    pricePerMillionOutput: String(initialData?.pricePerMillionOutput || ""),
  });

  const modelOptions = useMemo(
    () =>
      models
        .filter((model) => model.provider === formData.provider)
        .map((model) => ({
          value: model.id,
          label: model.displayName,
        })),
    [formData.provider, models],
  );

  const isValid =
    formData.provider &&
    formData.model &&
    formData.pricePerMillionInput &&
    formData.pricePerMillionOutput;

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (isValid) {
        onSave(formData);
      }
    },
    [formData, onSave, isValid],
  );

  return (
    <tr className="border-b bg-muted/30">
      <td colSpan={5} className="p-0">
        <form onSubmit={handleSubmit}>
          <div className="flex">
            <div className="p-4 flex-1">
              <Select
                value={formData.provider}
                onValueChange={(value) =>
                  setFormData({
                    ...formData,
                    provider: value as SupportedProvider,
                    model: "", // Clear model when provider changes
                  })
                }
              >
                <SelectTrigger id="provider" className="w-full">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {SupportedProviders.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {providerDisplayNames[provider]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="p-4 flex-1">
              <SearchableSelect
                value={formData.model}
                onValueChange={(value) =>
                  setFormData({ ...formData, model: value })
                }
                placeholder="Select or type model"
                items={modelOptions}
                allowCustom
                className="w-full"
              />
            </div>
            <div className="p-4 flex-1">
              <Input
                id="priceInput"
                type="number"
                step="0.01"
                min="0"
                value={formData.pricePerMillionInput}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    pricePerMillionInput: e.target.value,
                  })
                }
                placeholder="50.00"
                required
                className="w-full"
              />
            </div>
            <div className="p-4 flex-1">
              <Input
                id="priceOutput"
                type="number"
                step="0.01"
                min="0"
                value={formData.pricePerMillionOutput}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    pricePerMillionOutput: e.target.value,
                  })
                }
                placeholder="50.00"
                required
                className="w-full"
              />
            </div>
            <div className="p-4 flex gap-2">
              <Button type="submit" disabled={!isValid} size="sm">
                <Save className="h-4 w-4 mr-1" />
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                size="sm"
              >
                <X className="h-4 w-4 mr-1" />
                Cancel
              </Button>
            </div>
          </div>
        </form>
      </td>
    </tr>
  );
}

// Token Price Row Component for displaying/editing individual token prices
function TokenPriceRow({
  tokenPrice,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  models = [],
}: {
  tokenPrice: TokenPriceData;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (data: archestraApiTypes.UpdateTokenPriceData["body"]) => void;
  onCancel: () => void;
  onDelete: () => void;
  models?: ChatModel[];
}) {
  if (isEditing) {
    return (
      <TokenPriceInlineForm
        initialData={tokenPrice}
        onSave={onSave}
        onCancel={onCancel}
        models={models}
      />
    );
  }

  return (
    <tr className="border-b hover:bg-muted/30">
      <td className="p-4 capitalize">
        {providerDisplayNames[tokenPrice.provider]}
      </td>
      <td className="p-4 font-medium">{tokenPrice.model}</td>
      <td className="p-4">
        ${parseFloat(tokenPrice.pricePerMillionInput).toFixed(2)}
      </td>
      <td className="p-4">
        ${parseFloat(tokenPrice.pricePerMillionOutput).toFixed(2)}
      </td>
      <td className="p-4">
        <div className="flex items-center gap-2">
          <PermissionButton
            permissions={{ tokenPrice: ["update"] }}
            variant="ghost"
            size="sm"
            onClick={onEdit}
          >
            <Edit className="h-4 w-4" />
          </PermissionButton>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <PermissionButton
                permissions={{ tokenPrice: ["delete"] }}
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </PermissionButton>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Token Price</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete the pricing for{" "}
                  {tokenPrice.model}? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </td>
    </tr>
  );
}

export default function TokenPricePage() {
  const [editingTokenPriceId, setEditingTokenPriceId] = useState<string | null>(
    null,
  );
  const [isAddingTokenPrice, setIsAddingTokenPrice] = useState(false);

  const { data: tokenPrices = [], isLoading: tokenPricesLoading } =
    useTokenPrices();
  const { data: chatModels = [] } = useChatModelsQuery();
  const deleteTokenPrice = useDeleteTokenPrice();
  const createTokenPrice = useCreateTokenPrice();
  const updateTokenPrice = useUpdateTokenPrice();

  const handleDeleteTokenPrice = async (id: string) => {
    await deleteTokenPrice.mutateAsync({ id });
  };

  const handleCreateTokenPrice = async (
    data: archestraApiTypes.CreateTokenPriceData["body"],
  ) => {
    try {
      await createTokenPrice.mutateAsync(data);
      setIsAddingTokenPrice(false);
    } catch (error) {
      console.error("Failed to create token price:", error);
    }
  };

  const handleUpdateTokenPrice = async (
    id: string,
    data: archestraApiTypes.UpdateTokenPriceData["body"],
  ) => {
    try {
      await updateTokenPrice.mutateAsync({ id, ...data });
      setEditingTokenPriceId(null);
    } catch (error) {
      console.error("Failed to update token price:", error);
    }
  };

  const handleCancelEdit = () => {
    setEditingTokenPriceId(null);
    setIsAddingTokenPrice(false);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Token Pricing</CardTitle>
              <CardDescription>
                Configure token pricing for different models (per million
                tokens)
              </CardDescription>
            </div>
            <PermissionButton
              permissions={{ tokenPrice: ["create"] }}
              onClick={() => setIsAddingTokenPrice(true)}
              size="sm"
              disabled={isAddingTokenPrice || editingTokenPriceId !== null}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Model Price
            </PermissionButton>
          </div>
        </CardHeader>
        <CardContent>
          {tokenPricesLoading ? (
            <LoadingSkeleton count={3} prefix="token-prices" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Input Price ($)</TableHead>
                  <TableHead>Output Price ($)</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isAddingTokenPrice && (
                  <TokenPriceInlineForm
                    onSave={handleCreateTokenPrice}
                    onCancel={handleCancelEdit}
                    models={chatModels}
                  />
                )}
                {tokenPrices.length === 0 && !isAddingTokenPrice ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center py-8 text-muted-foreground"
                    >
                      <Settings className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>No token prices configured</p>
                      <p className="text-sm">
                        Click "Add Model Price" to get started
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  tokenPrices.map((tokenPrice) => (
                    <TokenPriceRow
                      key={tokenPrice.id}
                      tokenPrice={tokenPrice}
                      isEditing={editingTokenPriceId === tokenPrice.id}
                      onEdit={() => setEditingTokenPriceId(tokenPrice.id)}
                      onSave={(data) =>
                        handleUpdateTokenPrice(tokenPrice.id, data)
                      }
                      onCancel={handleCancelEdit}
                      onDelete={() => handleDeleteTokenPrice(tokenPrice.id)}
                      models={chatModels}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
