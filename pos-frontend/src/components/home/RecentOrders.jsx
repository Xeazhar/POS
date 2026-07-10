import React from 'react'
import { FaSearch } from "react-icons/fa";
import OrderList from './OrderList';
const RecentOrders = () => {
    return (
        <div className="px-8 mt-6">
            <div className="bg-gray-800 w-full h-[450px] rounded-lg">
                <div className="flex justify-between items-center px-6 py-4">
                    <h1 className="text-gray-100 text-lg font-semibold tracking-wide">Recent Orders</h1>
                    <a href="" className="text-blue-500 text-sm font-semibold">View All</a>


                </div>

                <div className="flex items-center gap-4 bg-gray-700 rounded-[15px] px-5 py-4 mx-6">
                    <FaSearch className="text-gray-100" />
                    <input
                    type="text"
                    placeholder="Search orders"
                    className="bg-gray-700 text-gray-100 outline-none"
                    />

                </div>

                {/* Order List */}
                <div className="mt-4 px-6 overflow-y-scroll h-[300px] scrollbar-hide">
                    <OrderList />
                    <OrderList />
                    <OrderList />
                    <OrderList />
                    <OrderList />
                    <OrderList />
                    <OrderList />
                    <OrderList />
                    <OrderList />
                </div>
            </div>

        </div>
 
    )
}

export default RecentOrders