import React from 'react';

const Minicard = ({ title, icon, number, footerNum }) => {
  return (
    <div className="bg-gray-800 py-5 px-5 rounded-lg w-[50%]">
        <div className="flex items-start justify-between">
            <h1 className="text-gray-100 text-lg font-semibold tracking-wide">{title}</h1>
            <button className={`${title === "Total Earnings" ? "bg-green-500" : "bg-orange-400"} text-gray-100 p-3 rounded-lg text-2xl`}>{icon}</button>
        </div>

        <div>
            <h1 className="text-4xl font-bold text-gray-100 mt-5">{number}</h1>
            <h1 className="text-gray-100 text-lg mt-2"><span className="text-green-500">{footerNum}%</span>  than yesterday</h1>
        </div>



    </div>
  
    )
}

export default Minicard;