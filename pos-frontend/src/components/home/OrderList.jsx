import React from 'react'
import { FaCheckDouble } from "react-icons/fa";
import { FaCircle } from "react-icons/fa6";

const OrderList = () => {
    return (
        <div className="flex items-center gap-5 mb-3">
            <button className="bg-orange-400 p-3 text-xl font-bold rounded-lg">AM </button>           
            <div className="flex items-center justify-between w-[100%]">
                <div className="flex flex-col items-start gap-1">
                    <h1 className="text-gray-100 text-lg font-semibold tracking-wide">Jazper Bustria</h1>
                    <p className="text-gray-200 text-sm">2 items</p>
                </div>
                <div>
                    <h1 className="text-orange-300 text-sm font-semibold border border-orange-300 rounded-lg p-1">Table No: 1</h1>
                </div>

                <div className="flex flex-col items-start gap-2">
                    <p className ="text-green-600 px-4"><FaCheckDouble className="inline mr-2"/>Ready</p>
                    <p className="text-gray-200 text-sm"><FaCircle className="inline mr-2 text-green-600" />Ready to serve</p>
                </div>
            </div>
        </div>
    )
}

export default OrderList