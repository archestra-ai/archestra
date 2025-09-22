import { Brain, Check, Edit2, Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/components/ui/dialog';
import { Input } from '@ui/components/ui/input';
import { ScrollArea } from '@ui/components/ui/scroll-area';
import { Textarea } from '@ui/components/ui/textarea';
import { type MemoryEntry } from '@ui/lib/clients/archestra/api/gen';
import { useMemoryStore } from '@ui/stores/memory-store';

interface MemoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface EditingState {
  id?: number;
  name: string;
  value: string;
}

export default function MemoryDialog({ open, onOpenChange }: MemoryDialogProps) {
  const { memories, isLoading, error, setMemory, deleteMemory, clearMemories, fetchMemories } = useMemoryStore();

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Refresh memories when dialog opens
  useEffect(() => {
    if (open) {
      fetchMemories();
    }
  }, [open, fetchMemories]);

  const handleEdit = (memory: MemoryEntry) => {
    setEditing({
      id: memory.id,
      name: memory.name,
      value: memory.value,
    });
    setAdding(false);
  };

  const handleSaveEdit = async () => {
    if (!editing) return;

    setIsSaving(true);
    try {
      await setMemory(editing.name, editing.value);
      setEditing(null);
    } catch (error) {
      console.error('Failed to save memory:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditing(null);
  };

  const handleAdd = () => {
    setAdding(true);
    setNewName('');
    setNewValue('');
    setEditing(null);
  };

  const handleSaveNew = async () => {
    if (!newName.trim()) return;

    setIsSaving(true);
    try {
      await setMemory(newName.trim(), newValue.trim());
      setAdding(false);
      setNewName('');
      setNewValue('');
    } catch (error) {
      console.error('Failed to add memory:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelNew = () => {
    setAdding(false);
    setNewName('');
    setNewValue('');
  };

  const handleDelete = async (name: string) => {
    if (confirm(`Are you sure you want to delete the memory "${name}"?`)) {
      try {
        await deleteMemory(name);
      } catch (error) {
        console.error('Failed to delete memory:', error);
      }
    }
  };

  const handleClearAll = async () => {
    if (confirm('Are you sure you want to delete all memories? This cannot be undone.')) {
      try {
        await clearMemories();
      } catch (error) {
        console.error('Failed to clear memories:', error);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            Your Memories
          </DialogTitle>
          <DialogDescription>Manage your stored memories as name-value pairs</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-[300px] max-h-[400px]">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-muted-foreground">Loading memories...</div>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-destructive">{error}</div>
            </div>
          ) : (
            <ScrollArea className="h-full w-full rounded-md border">
              <div className="p-4 space-y-3">
                {memories.length === 0 && !adding && (
                  <p className="text-muted-foreground text-center py-8">
                    No memories stored yet. Click "Add Memory" to create your first one.
                  </p>
                )}

                {memories.map((memory) => (
                  <div key={memory.id} className="rounded-lg border p-3 space-y-2 bg-card">
                    {editing?.id === memory.id ? (
                      <>
                        <Input
                          value={editing.name}
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                          placeholder="Memory name"
                          disabled={isSaving}
                          className="font-medium"
                        />
                        <Textarea
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          placeholder="Memory value"
                          disabled={isSaving}
                          className="min-h-[60px] resize-none"
                        />
                        <div className="flex gap-2 justify-end">
                          <Button size="sm" variant="ghost" onClick={handleCancelEdit} disabled={isSaving}>
                            <X className="h-4 w-4" />
                          </Button>
                          <Button size="sm" onClick={handleSaveEdit} disabled={isSaving || !editing.name.trim()}>
                            <Check className="h-4 w-4" />
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 space-y-1">
                            <div className="font-medium text-sm">{memory.name}</div>
                            <div className="text-sm text-muted-foreground whitespace-pre-wrap">{memory.value}</div>
                          </div>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => handleEdit(memory)}>
                              <Edit2 className="h-3 w-3" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => handleDelete(memory.name)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ))}

                {adding && (
                  <div className="rounded-lg border p-3 space-y-2 bg-card border-primary">
                    <Input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Memory name (e.g., 'user_preferences')"
                      disabled={isSaving}
                      autoFocus
                      className="font-medium"
                    />
                    <Textarea
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      placeholder="Memory value"
                      disabled={isSaving}
                      className="min-h-[60px] resize-none"
                    />
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="ghost" onClick={handleCancelNew} disabled={isSaving}>
                        Cancel
                      </Button>
                      <Button size="sm" onClick={handleSaveNew} disabled={isSaving || !newName.trim()}>
                        <Save className="h-4 w-4 mr-1" />
                        Save
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          )}
        </div>

        <div className="flex justify-between">
          <Button variant="outline" onClick={handleAdd} disabled={adding || editing !== null}>
            <Plus className="h-4 w-4 mr-2" />
            Add Memory
          </Button>
          {memories.length > 0 && (
            <Button variant="destructive" onClick={handleClearAll}>
              Clear All
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
