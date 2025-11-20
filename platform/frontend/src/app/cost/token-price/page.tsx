"use client";

import type { archestraApiTypes } from "@shared";
import { Edit, Plus, Save, Settings, Trash2, X } from "lucide-react";
import { useCallback, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
}: {
  initialData?: TokenPriceData;
  onSave: (data: archestraApiTypes.CreateTokenPriceData["body"]) => void;
  onCancel: () => void;
}) {
  const [formData, setFormData] = useState({
    model: initialData?.model || "",
    pricePerMillionInput: String(initialData?.pricePerMillionInput || ""),
    pricePerMillionOutput: String(initialData?.pricePerMillionOutput || ""),
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      onSave(formData);
    },
    [formData, onSave],
  );

  const isValid =
    formData.model &&
    formData.pricePerMillionInput &&
    formData.pricePerMillionOutput;

  return (
    <tr className="border-b">
      <td colSpan={4} className="p-4 bg-muted/30">
        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-center gap-4"
        >
          <div className="flex items-center gap-2">
            <Label htmlFor="model" className="text-sm whitespace-nowrap">
              Model
            </Label>
            <Input
              id="model"
              type="text"
              value={formData.model}
              onChange={(e) =>
                setFormData({ ...formData, model: e.target.value })
              }
              placeholder="e.g. gpt-4"
              required
              className="w-48"
            />
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="priceInput" className="text-sm whitespace-nowrap">
              Input Price ($)
            </Label>
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
              className="w-32"
            />
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="priceOutput" className="text-sm whitespace-nowrap">
              Output Price ($)
            </Label>
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
              className="w-32"
            />
          </div>

          <div className="flex gap-2 flex-shrink-0">
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
}: {
  tokenPrice: TokenPriceData;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (data: archestraApiTypes.UpdateTokenPriceData["body"]) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  if (isEditing) {
    return (
      <TokenPriceInlineForm
        initialData={tokenPrice}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  return (
    <tr className="border-b hover:bg-muted/30">
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
                  />
                )}
                {tokenPrices.length === 0 && !isAddingTokenPrice ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
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
