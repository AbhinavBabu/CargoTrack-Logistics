import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '../api';
import { PaginatedResponse, Shipment, ShipmentStatus } from '../types';
import Layout from '../components/Layout';
import ShipmentTable from '../components/ShipmentTable';
import { Plus, Search, Download, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';

export default function ShipmentsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [showReports, setShowReports] = useState(false);

  const { data, isLoading } = useQuery<PaginatedResponse<Shipment>>({
    queryKey: ['shipments', page, search, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('page', page.toString());
      params.set('limit', '10');
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      const { data } = await api.get(`/shipments?${params}`);
      return data;
    },
    // Poll every 8 seconds while any shipment on this page is still awaiting
    // AI risk analysis (aiRiskLevel === null). Stops automatically once all
    // shipments have been processed. Matches the pattern in ShipmentDetailPage.
    refetchInterval: (query) => {
      const shipments = (query.state.data as PaginatedResponse<Shipment> | undefined)?.data;
      if (!shipments || shipments.length === 0) return false;
      const anyPending = shipments.some((s) => !s.aiRiskLevel);
      return anyPending ? 8000 : false;
    },
  });

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const handleDownloadReport = async (type: string) => {
    setShowReports(false);
    try {
      const response = await api.get(`/reports/${type}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${type}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Report downloaded');
    } catch {
      toast.error('Failed to download report');
    }
  };

  const statuses: (ShipmentStatus | '')[] = ['', 'CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELAYED', 'CANCELLED'];

  return (
    <Layout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-100">Shipments</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {data ? `${data.pagination.total} total` : 'Loading...'} · Manage and track your freight
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Reports dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowReports(!showReports)}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 border border-slate-700 text-slate-400 text-sm font-medium rounded-lg hover:bg-slate-700 hover:text-slate-200 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Reports
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              {showReports && (
                <div className="absolute right-0 mt-1 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 py-1 z-10">
                  <button onClick={() => handleDownloadReport('shipment-history')}
                    className="w-full text-left px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors">
                    Shipment History
                  </button>
                  <button onClick={() => handleDownloadReport('shipment-summary')}
                    className="w-full text-left px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors">
                    Shipment Summary
                  </button>
                </div>
              )}
            </div>

            <Link
              to="/shipments/new"
              className="flex items-center gap-1.5 px-4 py-2 bg-amber-500 text-slate-900 text-sm font-semibold rounded-lg hover:bg-amber-400 transition-colors shadow-lg shadow-amber-500/20"
            >
              <Plus className="w-4 h-4" />
              New Shipment
            </Link>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-600" />
              <input
                type="text"
                placeholder="Search tracking #, title, sender..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500"
              />
            </div>
            <button
              onClick={handleSearch}
              className="px-4 py-2 bg-slate-800 border border-slate-700 text-slate-400 text-sm font-medium rounded-lg hover:bg-slate-700 hover:text-slate-200 transition-colors"
            >
              Search
            </button>
          </div>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 bg-slate-800 border border-slate-700 text-slate-400 text-sm rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            <option value="">All Statuses</option>
            {statuses.slice(1).map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <ShipmentTable shipments={data?.data || []} />

            {/* Pagination */}
            {data && data.pagination.totalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <p className="text-xs text-slate-600">
                  Showing {(data.pagination.page - 1) * data.pagination.limit + 1}–
                  {Math.min(data.pagination.page * data.pagination.limit, data.pagination.total)} of {data.pagination.total}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="px-3 py-1.5 text-xs border border-slate-700 rounded-lg text-slate-400 disabled:opacity-40 hover:bg-slate-800 hover:text-slate-200 transition-colors"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= data.pagination.totalPages}
                    className="px-3 py-1.5 text-xs border border-slate-700 rounded-lg text-slate-400 disabled:opacity-40 hover:bg-slate-800 hover:text-slate-200 transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
