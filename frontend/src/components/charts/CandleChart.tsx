import { useEffect, useRef } from 'react'
import { createChart, IChartApi } from 'lightweight-charts'

interface Candle {
  time: string
  open: number
  high: number
  low: number
  close: number
}

export default function CandleChart({ candles }: { candles: Candle[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#111827' }, textColor: '#9CA3AF' },
      grid: { vertLines: { color: '#1F2937' }, horzLines: { color: '#1F2937' } },
      width: containerRef.current.clientWidth,
      height: 360,
    })
    chartRef.current = chart

    const series = chart.addCandlestickSeries({
      upColor: '#22C55E',
      downColor: '#EF4444',
      borderVisible: false,
      wickUpColor: '#22C55E',
      wickDownColor: '#EF4444',
    })
    if (candles.length > 0) series.setData(candles)

    return () => chart.remove()
  }, [candles])

  return <div ref={containerRef} className="w-full" />
}
