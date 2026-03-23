import React from 'react';

export const FleetDashboard: React.FC = () => {
    return (
        <div className="p-6">
            <h1 className="text-2xl font-bold mb-4">Agent Fleet Dashboard</h1>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Agent Status Cards */}
                <div className="border rounded-lg p-4 bg-card">
                    <h2 className="font-semibold">Sovereign-Agent-1</h2>
                    <p className="text-sm text-muted-foreground">Status: Active</p>
                    <p className="text-sm text-muted-foreground">Tasks: 12 Completed</p>
                </div>
            </div>
        </div>
    );
};
